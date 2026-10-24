import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../lib/errors.js'
import { ctxOf } from './context.js'
import { actorId, requireUser } from './middleware.js'

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  event: z.string().max(80).optional(),
})

/**
 * Audit log routes (read-only, current user's own events). Requires an
 * authenticated dashboard session. No secrets are stored in audit rows — the
 * service redacts every event before persistence.
 */
export function auditRouter(): Router {
  const router = Router()

  // GET /api/audit?limit=&offset=&event=
  router.get('/', requireUser, (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const userId = actorId(res)
    if (!Number.isInteger(userId) || (userId as number) <= 0) {
      throw new AppError({ code: 'UNAUTHORIZED', message: 'Not signed in' })
    }
    const parsed = listSchema.safeParse(req.query)
    if (!parsed.success) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid audit query' })
    }
    if (!ctx.audit.isEnabled()) {
      res.json({ events: [], total: 0, enabled: false })
      return
    }
    // Only ever the caller's own events.
    const { rows, total } = ctx.audit.list({
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      event: parsed.data.event,
    })
    const events = rows.filter((r) => r.userId === userId)
    res.json({
      events,
      total: Math.min(total, events.length),
      enabled: true,
    })
  })

  // GET /api/audit/events — distinct event names for filtering.
  router.get('/events', (req: Request, res: Response) => {
    void req
    const ctx = ctxOf(req)
    if (!ctx.audit.isEnabled()) {
      res.json({ events: [] })
      return
    }
    res.json({ events: ctx.audit.events().slice(0, 200) })
  })

  return router
}