import { Router, Request, Response } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import { AppError } from '../lib/errors.js'
import { redact } from '../lib/redact.js'
import { requiresConfirmation, classifyStatement } from '../lib/sql-classify.js'
import { ctxOf } from './context.js'

const runSchema = z.object({
  sql: z.string().min(1).max(100_000),
  params: z.array(z.unknown()).max(100).optional(),
  statementTimeoutMs: z.coerce.number().int().min(1).max(300_000).optional(),
  maxRows: z.coerce.number().int().min(1).max(10_000).optional(),
  transaction: z
    .object({
      mode: z.enum(['begin', 'commit', 'rollback', 'auto']).default('auto'),
      // For 'begin' mode, whether the transaction is read-only and its isolation.
      readOnly: z.boolean().optional(),
      isolation: z.enum(['read committed', 'repeatable read']).optional(),
    })
    .optional(),
  // Set only after the operator acknowledged a data/structure-changing statement.
  confirmDestructive: z.boolean().optional(),
})

const saveSchema = z.object({
  name: z.string().min(1).max(120),
  sql: z.string().min(1).max(100_000),
})

const historySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export interface QueryHistoryEntry {
  id: string
  sql: string
  durationMs: number
  rowCount: number | null
  error: string | null
  createdAt: number
}

/**
 * SQL Studio. Every execution is bounded server-side (statement timeout, row
 * cap, request size, parameter count). All values are parameterized. Rows are
 * the only thing returned; the raw SQL is echoed but never merged with values.
 */
export function sqlRouter(): Router {
  const router = Router()
  // Per-dashboard-session in-memory history; never persisted, always redacted.
  const history = new Map<string, QueryHistoryEntry[]>()

  function primary(req: Request, res: Response) {
    const ctx = ctxOf(req)
    return ctx.providerSessions.allocatePrimary(
      String(res.locals.sessionRef ?? ''),
      Number(res.locals.userId),
    )
  }

  function userHistory(sessionRef: string): QueryHistoryEntry[] {
    return history.get(sessionRef) ?? []
  }

  function pushHistory(sessionRef: string, entry: QueryHistoryEntry): void {
    const list = userHistory(sessionRef)
    list.unshift(entry)
    if (list.length > 200) list.length = 200
    history.set(sessionRef, list)
  }

  // POST /api/sql/run — execute a single statement
  router.post('/run', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const parsed = runSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid SQL payload' })
    }
    const { sql, params, statementTimeoutMs, maxRows, transaction, confirmDestructive } = parsed.data
    const { qs } = await primary(req, res)

    if (requiresConfirmation(sql) && confirmDestructive !== true) {
      throw new AppError({
        code: 'CONFIRMATION_REQUIRED',
        message:
          'This statement can modify data or database structure. Review it and confirm before running.',
      })
    }

    const mode: 'auto' | 'begin' | 'commit' | 'rollback' = transaction?.mode ?? 'auto'

    const started = Date.now()
    try {
      if (mode === 'begin') {
        await qs.beginTransaction({ readOnly: transaction?.readOnly, isolation: transaction?.isolation })
      } else if (mode === 'commit') {
        await qs.commitTransaction()
        pushHistory(sessionRef, { id: crypto.randomUUID(), sql, durationMs: 0, rowCount: null, error: null, createdAt: Date.now() })
        res.json({ ok: true, event: 'commit', durationMs: Date.now() - started })
        return
      } else if (mode === 'rollback') {
        await qs.rollbackTransaction()
        pushHistory(sessionRef, { id: crypto.randomUUID(), sql, durationMs: 0, rowCount: null, error: null, createdAt: Date.now() })
        res.json({ ok: true, event: 'rollback', durationMs: Date.now() - started })
        return
      }

      const result = await qs.execute({ sql, params }, { statementTimeoutMs, maxRows })
      ctx.audit.write({
        userId: Number(res.locals.userId),
        sessionId: sessionRef,
        event: 'sql.execute',
        status: 'ok',
        target: 'query',
        detail: redact(`statement=${sql.slice(0, 120)} rows=${result.rowCount ?? 0} durationMs=${result.durationMs}`, {
          secrets: ctx.providerSessions.secretHints(sessionRef),
        }),
      })
      pushHistory(sessionRef, {
        id: crypto.randomUUID(),
        sql,
        durationMs: result.durationMs,
        rowCount: result.rowCount,
        error: null,
        createdAt: Date.now(),
      })
      res.json({
        ok: true,
        result,
        classification: classifyStatement(sql),
        durationMs: result.durationMs,
      })
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError({ code: 'QUERY_ERROR', message: 'Query failed', cause: err })
      pushHistory(sessionRef, {
        id: crypto.randomUUID(),
        sql,
        durationMs: Date.now() - started,
        rowCount: null,
        error: appErr.message,
        createdAt: Date.now(),
      })
      throw appErr
    }
  })

  // POST /api/sql/cancel — cancel the currently running statement
  router.post('/cancel', async (req: Request, res: Response) => {
    const { qs } = await primary(req, res)
    await qs.cancel('current')
    res.json({ ok: true })
  })

  // POST /api/sql/saved — save a query
  router.post('/saved', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const userId = Number(res.locals.userId)
    const parsed = saveSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid saved query' })
    const id = crypto.randomUUID()
    ctx.store.saveQuery({
      id,
      userId,
      name: parsed.data.name,
      sql: parsed.data.sql,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    res.json({ saved: { id, name: parsed.data.name, sql: parsed.data.sql } })
  })

  // GET /api/sql/saved — list saved queries
  router.get('/saved', (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const saved = ctx.store.listSavedQueries(Number(res.locals.userId))
    res.json({ saved })
  })

  // DELETE /api/sql/saved/:id
  router.delete('/saved/:id', (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const id = String(req.params.id ?? '')
    const ok = ctx.store.deleteSavedQuery(id, Number(res.locals.userId))
    if (!ok) throw new AppError({ code: 'NOT_FOUND', message: 'Saved query not found' })
    res.json({ ok: true })
  })

  // GET /api/sql/history — recent queries for this session (secrets redacted)
  router.get('/history', (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const parsed = historySchema.safeParse(req.query)
    const limit = parsed.success ? parsed.data.limit : 50
    const sessionRef = String(res.locals.sessionRef ?? '')
    const list = userHistory(sessionRef).slice(0, limit)
    const secrets = ctx.providerSessions.secretHints(sessionRef)
    res.json({
      history: list.map((h) => ({
        ...h,
        sql: redact(h.sql, { secrets }),
      })),
    })
  })

  return router
}