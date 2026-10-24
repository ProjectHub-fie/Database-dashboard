import { Router, Request, Response } from 'express'
import { ctxOf } from './context.js'
import { PLANNED_PROVIDERS } from '../providers/registry.js'

/**
 * Provider catalog for the connection screen.
 *
 * Registered providers are reported with the auth methods they actually
 * implement, taken from `capabilities()` rather than a hardcoded UI table.
 * Planned providers are returned with `available: false` and the reason they are
 * blocked, so the selector can show them as unavailable instead of offering a
 * mode that would fail.
 */
export function providersRouter(): Router {
  const router = Router()

  router.get('/', (req: Request, res: Response) => {
    const ctx = ctxOf(req)

    const enabled = ctx.registry.list().map((p) => {
      const caps = p.capabilities()
      return {
        id: p.info.id,
        name: p.info.name,
        kind: p.info.kind,
        available: true,
        authMethods: [...caps.auth],
        controlPlane: p.info.controlPlane,
        apiDocs: p.info.apiDocs,
        capabilities: [...caps.capabilities].sort(),
      }
    })

    const planned = PLANNED_PROVIDERS.filter((p) => !ctx.registry.get(p.id)).map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      available: false,
      authMethods: [] as string[],
      controlPlane: false,
      blockedBy: p.blockedBy,
      capabilities: [] as string[],
    }))

    res.json({ providers: [...enabled, ...planned] })
  })

  return router
}
