import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../lib/errors.js'
import { ctxOf } from './context.js'
import { actorId } from './middleware.js'
import { redact } from '../lib/redact.js'
import { verifyNeonConnectionUrl } from '../security/netlib.js'
import { NeonProvider } from '../providers/neon/provider.js'
import { capabilitiesForAuth, serializeCapabilities } from '../providers/registry.js'
import { readOnlyRoles } from '../security/roles.js'
import { config } from '../config.js'

/** Optional operator label for the connection. Never used in SQL or URLs. */
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // Reject control characters so the label cannot forge log lines or UI text.
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), { message: 'Display name contains control characters' })
  .optional()

const connectUrlSchema = z.object({
  providerId: z.literal('neon'),
  connectionString: z.string().min(9).max(2000),
  displayName: displayNameSchema,
})

const connectApiSchema = z.object({
  providerId: z.literal('neon'),
  apiKey: z.string().min(8).max(2000),
  displayName: displayNameSchema,
})

const identPart = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/)
const neonIdPart = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/)

/** Pick a database inside an API-key session, exactly like a URL connection. */
const attachDatabaseSchema = z.object({
  projectId: neonIdPart,
  branchId: neonIdPart,
  databaseName: identPart,
  role: identPart.optional(),
  pooled: z.boolean().optional(),
  displayName: displayNameSchema,
})

export function connectionsRouter(): Router {
  const router = Router()

  // GET /api/connections/status — current connection state (no credentials).
  router.get('/status', (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const p = ctx.providerSessions.get(sessionRef)
    if (!p) {
      res.json({ connected: false })
      return
    }
    ctx.providerSessions.touch(sessionRef)
    res.json({
      connected: true,
      auth: p.auth,
      providerId: p.providerId,
      metadata: p.metadata,
      accountOnly: p.accountOnly,
      capabilities: serializeCapabilities(
        capabilitiesForAuth(ctx.registry.capabilities(p.providerId), p.auth),
      ),
    })
  })

  // POST /api/connections/url — connect with a database URL.
  router.post('/url', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const { connectionString, displayName } = connectUrlSchema.parse(req.body ?? {})
    const provider = ctx.registry.require('neon') as NeonProvider

    // Host allowlisting, DNS pinning and TLS are all enforced by
    // verifyNeonConnectionUrl (single source of truth).

    // Verify + pin the host BEFORE building any client.
    const url = new URL(connectionString)
    const decodedPass = url.password ? decodeURIComponent(url.password) : ''
    const verified = await verifyNeonConnectionUrl(connectionString, {
      allowLocalhost: config.nodeEnv !== 'production',
    })

    const clientOpts = {
      host: verified.host,
      port: verified.port,
      database: verified.database,
      role: verified.role,
      password: decodedPass,
      pinnedAddress: verified.verified.address,
    }

    const connRef = await providerConnectWithUrl(provider, clientOpts)
    const readOnly = readOnlyRoles.has(verified.role.toLowerCase())

    ctx.providerSessions.create({
      sessionId: sessionRef,
      userId: actorId(res),
      providerId: 'neon',
      auth: 'connection',
      connection: connRef,
      controlPlane: null,
      accountOnly: false,
      metadata: {
        host: verified.host,
        database: verified.database,
        role: verified.role,
        readOnly,
        ...(displayName ? { displayName } : {}),
      },
      secretHints: [decodedPass, verified.role, verified.database].filter((s) => s.length > 0),
    })

    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'connection.connect',
      status: 'ok',
      target: `${verified.host}/${verified.database}`,
      detail: redact(`auth=connection host=${verified.host} database=${verified.database} role=${verified.role}`, {
        secrets: [decodedPass, verified.role],
      }),
    })

    res.json({
      connected: true,
      metadata: {
        host: verified.host,
        database: verified.database,
        role: verified.role,
        readOnly,
        ...(displayName ? { displayName } : {}),
      },
      accountOnly: false,
      capabilities: serializeCapabilities(
        capabilitiesForAuth(ctx.registry.capabilities('neon'), 'connection'),
      ),
    })
  })

  // POST /api/connections/api — connect with a Neon API key.
  router.post('/api', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const { apiKey, displayName } = connectApiSchema.parse(req.body ?? {})
    const provider = ctx.registry.require('neon') as NeonProvider
    const control = provider.controlPlaneFor(apiKey)
    const validation = await control.validateApiKey()

    ctx.providerSessions.create({
      sessionId: sessionRef,
      userId: actorId(res),
      providerId: 'neon',
      auth: 'api',
      connection: null,
      controlPlane: control,
      accountOnly: true,
      metadata: {
        host: 'console.neon.tech',
        database: '',
        role: '',
        readOnly: false,
        ...(displayName ? { displayName } : {}),
      },
      secretHints: [apiKey],
      usageUntil: Date.now() + 4 * 60 * 60 * 1000,
    })

    const p = ctx.providerSessions.get(sessionRef)!
    p.controlPlane = control

    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'connection.connect',
      status: 'ok',
      target: 'api-key',
      detail: redact(`auth=api organizations=${validation.organizations?.length ?? 0}`, {
        secrets: [apiKey],
      }),
    })

    res.json({
      connected: true,
      auth: 'api',
      metadata: {
        host: 'console.neon.tech',
        database: '',
        role: '',
        readOnly: false,
        ...(displayName ? { displayName } : {}),
      },
      accountOnly: true,
      capabilities: serializeCapabilities(
        capabilitiesForAuth(ctx.registry.capabilities('neon'), 'api'),
      ),
      organizations: validation.organizations ?? [],
      organizationScoped: validation.organizationScoped === true,
    })
  })

  /**
   * POST /api/connections/database — bind a database to an API-key session.
   *
   * Neon returns a credential-bearing URI; it is verified with the same host
   * allowlist, DNS pinning and TLS path as a pasted URL, then consumed
   * server-side. Only safe metadata is returned.
   */
  router.post('/database', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const p = ctx.providerSessions.require(sessionRef, actorId(res))
    if (p.auth !== 'api' || !p.controlPlane) {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only an API-key connection can attach a database by project, branch and name.',
      })
    }
    const body = attachDatabaseSchema.parse(req.body ?? {})
    const cp = p.controlPlane
    if (typeof cp.getConnectionUri !== 'function') {
      throw new AppError({
        code: 'NOT_IMPLEMENTED',
        message: 'This provider cannot open database sessions from an API key.',
      })
    }

    const provider = ctx.registry.require(p.providerId) as NeonProvider
    const uri = await cp.getConnectionUri({
      projectId: body.projectId,
      branchId: body.branchId,
      databaseName: body.databaseName,
      ...(body.role ? { role: body.role } : {}),
      ...(body.pooled !== undefined ? { pooled: body.pooled } : {}),
    })

    // Same guard as URL mode: approved Neon host, resolved address pinned, TLS
    // verified. A URI from the provider API is not trusted just because of its
    // origin — it is a network destination like any other.
    const verified = await verifyNeonConnectionUrl(uri, {
      allowLocalhost: config.nodeEnv !== 'production',
    })
    const password = new URL(uri).password
    const decodedPass = password ? decodeURIComponent(password) : ''

    const connRef = await providerConnectWithUrl(provider, {
      host: verified.host,
      port: verified.port,
      database: verified.database,
      role: verified.role,
      password: decodedPass,
      pinnedAddress: verified.verified.address,
    })

    // Region/project/branch labels are display-only; a failed lookup must not
    // cost the operator the connection they just opened.
    let projectName: string | undefined
    let branchName: string | undefined
    let region: string | undefined
    try {
      const [project, branches] = await Promise.all([
        cp.getProject({ projectId: body.projectId }),
        cp.listBranches({ projectId: body.projectId }),
      ])
      projectName = project.name
      region = project.region
      branchName = branches.find((b) => b.id === body.branchId)?.name
    } catch {
      // ignore: metadata is cosmetic
    }

    const metadata = {
      host: verified.host,
      database: verified.database,
      role: verified.role,
      readOnly: readOnlyRoles.has(verified.role.toLowerCase()),
      projectId: body.projectId,
      branchId: body.branchId,
      ...(projectName ? { projectName } : {}),
      ...(branchName ? { branchName } : {}),
      ...(region ? { region } : {}),
      ...(body.displayName ?? p.metadata?.displayName ? { displayName: body.displayName ?? p.metadata!.displayName } : {}),
    }

    await ctx.providerSessions.attachConnection(sessionRef, actorId(res), {
      connection: connRef,
      metadata,
      secretHints: [decodedPass, verified.role, verified.database],
    })

    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'connection.database',
      status: 'ok',
      target: `${verified.host}/${verified.database}`,
      detail: redact(
        `auth=api project=${body.projectId} branch=${body.branchId} database=${verified.database} role=${verified.role}`,
        { secrets: [decodedPass, uri] },
      ),
    })

    res.json({
      connected: true,
      auth: 'api',
      metadata,
      accountOnly: false,
      capabilities: serializeCapabilities(
        capabilitiesForAuth(ctx.registry.capabilities(p.providerId), 'api'),
      ),
    })
  })

  // POST /api/connections/database/detach — back to account-only, key retained.
  router.post('/database/detach', async (req: Request, res: Response) => {
    void req
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const p = await ctx.providerSessions.detachConnection(sessionRef, actorId(res))
    p.metadata = p.metadata ? { ...p.metadata, host: 'console.neon.tech', database: '', role: '', readOnly: false } : p.metadata
    ctx.audit.write({
      userId: actorId(res),
      sessionId: sessionRef,
      event: 'connection.detach',
      status: 'ok',
      target: p.providerId,
    })
    res.json({
      connected: true,
      auth: p.auth,
      metadata: p.metadata,
      accountOnly: true,
      capabilities: serializeCapabilities(
        capabilitiesForAuth(ctx.registry.capabilities(p.providerId), p.auth),
      ),
    })
  })

  // POST /api/connections/list-session — restore a session for the current user.
  // Since provider credentials are in-memory only, a page refresh reconnects.

  // POST /api/connections/disconnect
  router.post('/disconnect', async (req: Request, res: Response) => {
    void req
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const p = ctx.providerSessions.get(sessionRef)
    if (p) {
      await ctx.providerSessions.destroy(p)
      ctx.audit.write({
        userId: actorId(res),
        sessionId: sessionRef,
        event: 'connection.disconnect',
        status: 'ok',
        target: p.providerId,
      })
    }
    res.json({ ok: true })
  })

  // GET /api/connections/health — latency probe over the live connection.
  router.get('/health', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const p = ctx.providerSessions.require(sessionRef, actorId(res))
    ctx.providerSessions.touch(sessionRef)
    if (p.accountOnly || !p.connection) {
      res.json({ reachable: false, detail: 'This connection has no live database session (management-only API connection).' })
      return
    }
    const provider = ctx.registry.require(p.providerId)
    const started = Date.now()
    try {
      const { latencyMs, version } = await provider.database!.ping(p.connection.conn as never)
      ctx.audit.write({
        userId: actorId(res),
        sessionId: sessionRef,
        event: 'connection.health',
        status: 'ok',
        detail: `latencyMs=${latencyMs}`,
      })
      res.json({ reachable: true, latencyMs, version, host: p.metadata?.host, database: p.metadata?.database })
    } catch (err) {
      res.json({
        reachable: false,
        latencyMs: Date.now() - started,
        error: safe(err),
      })
    }
  })

  // GET /api/connections/preview — validate a URL without connecting (returns safe metadata only).
  router.post('/preview', async (req: Request, res: Response) => {
    void req
    const { connectionString } = connectUrlSchema.parse(req.body ?? {})
    const meta = await verifyNeonConnectionUrl(connectionString, {
      allowLocalhost: config.nodeEnv !== 'production',
    })
    const readOnly = readOnlyRoles.has(meta.role.toLowerCase())
    res.json({
      host: meta.host,
      database: meta.database,
      role: meta.role,
      readOnly,
      port: meta.port,
      hostVerified: true,
    })
  })

  // GET /api/connections/supported-hosts — informational only (no secrets).
  router.get('/supported-hosts', (_req: Request, res: Response) => {
    res.json({
      message:
        'Only Neon PostgreSQL hosts are allowed (suffix *.neon.tech / *.neon.build) plus localhost in development.',
      hosts: ['*.neon.tech', '*.neon.build'],
    })
  })

  return router
}

async function providerConnectWithUrl(
  _provider: NeonProvider,
  opts: {
    host: string
    port: number
    database: string
    role: string
    password: string
    pinnedAddress: string
  },
) {
  // The NeonProvider.connect() path performs its own URL verification; to avoid
  // double-parsing we drive the underlying client directly through the adapter.
  const { buildPgClient, PostgresAdapter } = await import('../adapters/postgres.js')
  const adapter = new PostgresAdapter()
  const client = buildPgClient({
    host: opts.host,
    port: opts.port,
    database: opts.database,
    role: opts.role,
    password: opts.password,
    pinnedAddress: opts.pinnedAddress,
    applicationName: 'db-remote',
  })
  try {
    await client.connect()
  } catch (err) {
    await client.end().catch(() => undefined)
    throw adapter.translatePgError(err)
  }
  const streamFactory = (client as unknown as { connection?: { stream?: unknown } }).connection?.stream
  return {
    id: randomId(),
    providerId: 'neon',
    conn: {
      client,
      role: opts.role,
      database: opts.database,
      pinnedAddress: opts.pinnedAddress,
      clientOptions: {
        host: opts.host,
        port: opts.port,
        database: opts.database,
        user: opts.role,
        password: opts.password,
        ssl: { rejectUnauthorized: true, servername: opts.host },
        stream: streamFactory,
        connectionTimeoutMillis: 10_000,
        applicationName: 'db-remote',
      },
    },
    metadata: {
      providerId: 'neon',
      host: opts.host,
      database: opts.database,
      role: opts.role,
      readOnly: readOnlyRoles.has(opts.role.toLowerCase()),
      region: undefined,
    },
    refcount: 0,
    lastActiveAt: Date.now(),
  }
}

function safe(err: unknown): string {
  return err instanceof AppError ? err.message : 'Database is not reachable'
}

import crypto from 'node:crypto'
function randomId(): string {
  return crypto.randomBytes(12).toString('hex')
}

import type { ConnectionRef, Provider } from '../providers/types.js'
export type { ConnectionRef, Provider }