import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../lib/errors.js'
import { ctxOf } from './context.js'
import { requireRecentAuth, actorId } from './middleware.js'

const createDatabaseSchema = z.object({
  projectId: z.string().min(1).max(100),
  branchId: z.string().min(1).max(100),
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/),
  owner: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/).optional(),
})

const createProjectSchema = z.object({
  name: z.string().min(1).max(64),
  orgId: z.string().min(1).max(100).optional(),
  region: z.string().min(2).max(40).optional(),
})

const createBranchSchema = z.object({
  projectId: z.string().min(1).max(100),
  name: z.string().min(1).max(64).optional(),
  parentId: z.string().min(1).max(100).optional(),
})

/**
 * Neon control-plane routes (API-key mode only). In database-URL mode the
 * dashboard intentionally exposes no account-level management.
 */
export function controlPlaneRouter(): Router {
  const router = Router()

  /** Require an API-key provider session with a live control plane. */
  function control(req: Request, res: Response) {
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const session = ctx.providerSessions.require(sessionRef, actorId(res))
    if (session.auth !== 'api' || !session.controlPlane) {
      throw new AppError({
        code: 'FORBIDDEN',
        message:
          'Account management requires an API-key connection. Database-URL sessions cannot manage Neon resources.',
      })
    }
    return { ctx, sessionRef, session, cp: session.controlPlane }
  }

  // GET /api/control/status — which operations are available (capability-aware)
  router.get('/status', (req: Request, res: Response) => {
    const { session } = control(req, res)
    res.json({
      mode: 'account',
      provider: session.providerId,
      accountOnly: session.accountOnly,
    })
  })

  // GET /api/control/organizations
  router.get('/organizations', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const organizations = await cp.listOrganizations()
    res.json({ organizations })
  })

  // GET /api/control/projects?orgId=
  router.get('/projects', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const orgId = typeof req.query.orgId === 'string' && req.query.orgId ? req.query.orgId : undefined
    const projects = await cp.listProjects(orgId)
    res.json({ projects })
  })

  // GET /api/control/projects/:projectId
  router.get('/projects/:projectId', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const projectId = String(req.params.projectId)
    if (!projectId) throw new AppError({ code: 'BAD_REQUEST', message: 'projectId is required' })
    const project = await cp.getProject({ projectId })
    res.json({ project })
  })

  // POST /api/control/projects — create project
  router.post('/projects', async (req: Request, res: Response) => {
    const { ctx, sessionRef, cp } = control(req, res)
    const parsed = createProjectSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid project payload' })
    const { project, operation } = await cp.createProject(parsed.data)
    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'control.create_project',
      status: 'ok',
      target: project.id,
      detail: `name=${project.name} region=${project.region ?? 'default'}`,
    })
    res.json({ project, operation })
  })

  // DELETE /api/control/projects/:projectId — destructive
  router.delete('/projects/:projectId', requireRecentAuth, async (req: Request, res: Response) => {
    const { ctx, sessionRef, cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const confirmation = String(req.query.confirm ?? '')
    if (confirmation !== projectId) {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Type the project name to confirm deletion',
      })
    }
    const { operation } = await cp.deleteProject({ projectId })
    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'control.delete_project',
      status: 'ok',
      target: projectId,
    })
    res.json({ operation })
  })

  // GET /api/control/projects/:projectId/branches
  router.get('/projects/:projectId/branches', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const branches = await cp.listBranches({ projectId })
    res.json({ branches })
  })

  // POST /api/control/projects/:projectId/branches
  router.post('/projects/:projectId/branches', async (req: Request, res: Response) => {
    const { ctx, sessionRef, cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const parsed = createBranchSchema
      .pick({ name: true, parentId: true })
      .safeParse({ ...req.body, projectId })
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid branch payload' })
    const { branch, operation } = await cp.createBranch({ projectId, ...parsed.data })
    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'control.create_branch',
      status: 'ok',
      target: `${projectId}/${branch.id}`,
      detail: `name=${branch.name}`,
    })
    res.json({ branch, operation })
  })

  // DELETE /api/control/projects/:projectId/branches/:branchId — destructive
  router.delete('/projects/:projectId/branches/:branchId', requireRecentAuth, async (req: Request, res: Response) => {
    const { ctx, sessionRef, cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const branchId = String(req.params.branchId)
    const confirmation = String(req.query.confirm ?? '')
    if (confirmation !== branchId) {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Type the branch id to confirm deletion',
      })
    }
    const { operation } = await cp.deleteBranch({ projectId, branchId })
    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'control.delete_branch',
      status: 'ok',
      target: `${projectId}/${branchId}`,
    })
    res.json({ operation })
  })

  // GET /api/control/projects/:projectId/databases?branchId=
  router.get('/projects/:projectId/databases', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const branchId = req.query.branchId ? String(req.query.branchId) : ''
    if (!branchId) throw new AppError({ code: 'BAD_REQUEST', message: 'branchId is required' })
    const databases = await cp.listDatabases({ projectId, branchId })
    res.json({ databases })
  })

  // GET /api/control/projects/:projectId/roles?branchId=
  //
  // Roles are branch-scoped, so `branchId` is required rather than defaulted:
  // silently listing the primary branch's roles would offer a role that does
  // not exist on the branch the operator actually picked.
  router.get('/projects/:projectId/roles', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const branchId = req.query.branchId ? String(req.query.branchId) : ''
    if (!branchId) throw new AppError({ code: 'BAD_REQUEST', message: 'branchId is required' })
    if (typeof cp.listRoles !== 'function') {
      throw new AppError({
        code: 'NOT_IMPLEMENTED',
        message: 'This provider does not expose database roles.',
      })
    }
    const roles = await cp.listRoles({ projectId, branchId })
    res.json({ roles })
  })

  // POST /api/control/projects/:projectId/databases
  router.post('/projects/:projectId/databases', async (req: Request, res: Response) => {
    const { ctx, sessionRef, cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const parsed = createDatabaseSchema.safeParse({ ...req.body, projectId })
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid database payload' })
    const { database, operation } = await cp.createDatabase(parsed.data)
    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'control.create_database',
      status: 'ok',
      target: `${parsed.data.projectId}/${parsed.data.branchId}/${database.name}`,
      detail: `owner=${parsed.data.owner ?? 'default'}`,
    })
    res.json({ database, operation })
  })

  // DELETE /api/control/projects/:projectId/databases/:databaseName?branchId=&connected=...
  // Destructive: typed confirmation + live target validation.
  router.delete('/projects/:projectId/databases/:databaseName', requireRecentAuth, async (req: Request, res: Response) => {
    const { ctx, sessionRef, cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const databaseName = String(req.params.databaseName)
    const branchId = String(req.query.branchId ?? '')
    if (!branchId) throw new AppError({ code: 'BAD_REQUEST', message: 'branchId is required' })
    const confirmation = String(req.query.confirm ?? '')
    if (confirmation !== databaseName) {
      throw new AppError({
        code: 'FORBIDDEN',
        message: `Type the database name '${databaseName}' to confirm deletion`,
      })
    }
    // Final server-side target validation before the call.
    const databases = await cp.listDatabases({ projectId, branchId })
    const found = databases.some((d) => d.name === databaseName)
    if (!found) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Target database not found in the selected project/branch' })
    }
    const { operation } = await cp.deleteDatabase({ projectId, branchId, databaseName })
    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'control.delete_database',
      status: 'ok',
      target: `${projectId}/${branchId}/${databaseName}`,
    })
    res.json({ operation })
  })

  // GET /api/control/projects/:projectId/endpoints
  router.get('/projects/:projectId/endpoints', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const endpoints = await cp.listEndpoints({ projectId })
    res.json({ endpoints })
  })

  // GET /api/control/projects/:projectId/operation/:operationId
  router.get('/projects/:projectId/operation/:operationId', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const projectId = String(req.params.projectId)
    const operationId = String(req.params.operationId)
    const operation = await cp.getOperation({ operationId, projectId })
    res.json({ operation })
  })

  // GET /api/control/operations?projectId=&limit=
  router.get('/operations', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : ''
    if (!projectId) throw new AppError({ code: 'BAD_REQUEST', message: 'projectId is required' })
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    const operations = await cp.listOperations({ projectId, limit })
    res.json({ operations })
  })

  // GET /api/control/connection-info
  router.get('/connection-info', async (req: Request, res: Response) => {
    const { cp } = control(req, res)
    const parsed = z
      .object({
        projectId: z.string().min(1),
        branchId: z.string().min(1),
        databaseName: z.string().min(1),
      })
      .safeParse(req.query)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'projectId, branchId and databaseName are required' })
    const info = await cp.getConnectionInfo({
      projectId: parsed.data.projectId,
      branchId: parsed.data.branchId,
      databaseName: parsed.data.databaseName,
    })
    res.json({ info })
  })

  return router
}