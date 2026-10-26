import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../lib/errors.js'
import { ctxOf } from './context.js'
import { requireRecentAuth, actorId } from './middleware.js'
import { csvHeader, csvRow, exportFilename, jsonValue } from '../lib/tabular.js'

const identSchema = z.object({
  schema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/),
  table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/),
})

const browseSchema = identSchema.extend({
  offset: z.coerce.number().int().min(0).max(2_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  orderBy: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/).optional(),
  orderDir: z.enum(['asc', 'desc']).optional(),
  search: z.string().max(200).optional(),
})

const rowMutationSchema = z.object({
  schema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/),
  table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/),
})

const MAX_ROW_BODY = 500

/** Hard server-side ceiling for a single export file. The query string can
 *  lower this, never raise it. */
const EXPORT_MAX_ROWS = 50_000

const exportSchema = identSchema.extend({
  format: z.enum(['csv', 'json']).default('csv'),
  limit: z.coerce.number().int().min(1).max(EXPORT_MAX_ROWS).default(10_000),
  orderBy: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/).optional(),
  orderDir: z.enum(['asc', 'desc']).optional(),
  search: z.string().max(200).optional(),
})

export function dataRouter(): Router {
  const router = Router()

  /** Require a live database session and return its query session. */
  function primary(req: Request, res: Response) {
    const ctx = ctxOf(req)
    const sessionRef = String(res.locals.sessionRef ?? '')
    const userId = actorId(res)
    return ctx.providerSessions.allocatePrimary(sessionRef, userId)
  }

  // GET /api/data/tree — schema + table tree
  router.get('/tree', async (req: Request, res: Response) => {
    const { qs } = await primary(req, res)
    const tree = await qs.getSchemaTree()
    res.json({ tree })
  })

  // GET /api/data/tables — flat list of schema objects
  router.get('/tables', async (req: Request, res: Response) => {
    const { qs } = await primary(req, res)
    const objects = await qs.listTableObjects()
    res.json({ objects })
  })

  // GET /api/data/table-info
  router.get('/table-info', async (req: Request, res: Response) => {
    const { qs } = await primary(req, res)
    const parsed = identSchema.safeParse(req.query)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'schema and table are required' })
    const info = await qs.getTableInfo(parsed.data)
    res.json({ info })
  })

  // GET /api/data/rows — paginated, sortable, searchable rows
  router.get('/rows', async (req: Request, res: Response) => {
    const { qs } = await primary(req, res)
    const parsed = browseSchema.safeParse(req.query)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid browse parameters' })
    const { schema, table, offset, limit, orderBy, orderDir, search } = parsed.data
    const page = await qs.browseRows(schema, table, { offset, limit, orderBy, orderDir, search })
    res.json({ page })
  })

  /**
   * GET /api/data/export — download a table as CSV or JSON.
   *
   * Exports used to be built in the browser from `/api/data/rows`, but that
   * route caps `limit` at 500 for interactive paging, so asking for 10,000 rows
   * answered 400 and every export button failed. The file is now produced here,
   * with the same filters and ordering the browser shows.
   */
  router.get('/export', async (req: Request, res: Response) => {
    const parsed = exportSchema.safeParse(req.query)
    if (!parsed.success) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: `Invalid export parameters (limit must be 1-${EXPORT_MAX_ROWS})`,
      })
    }
    const { qs } = await primary(req, res)
    const { schema, table, format, limit, orderBy, orderDir, search } = parsed.data
    const out = await qs.exportTableRows({ schema, table, maxRows: limit, orderBy, orderDir, search })

    res.status(200)
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(schema, table, format)}"`)
    res.setHeader('X-Export-Rows', String(out.rowCount))
    res.setHeader('X-Export-Truncated', String(out.truncated))
    res.setHeader('X-Export-Limit', String(limit))

    if (format === 'csv') {
      res.write(`${csvHeader(out.columns)}\n`)
      for await (const row of out.rows) res.write(`${csvRow(out.columns, row)}\n`)
    } else {
      // Written incrementally so one wide table does not become one string.
      let first = true
      res.write('[\n')
      for await (const row of out.rows) {
        if (!first) res.write(',\n')
        res.write(JSON.stringify(Object.fromEntries(out.columns.map((c) => [c, jsonValue(row[c])]))))
        first = false
      }
      res.write('\n]\n')
    }
    res.end()
  })

  // POST /api/data/rows — insert a row
  router.post('/rows', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const { qs } = await primary(req, res)
    const body = z
      .object({ ...rowMutationSchema.shape, row: z.record(z.unknown()) })
      .safeParse(req.body)
    if (!body.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid row payload' })
    if (Object.keys(body.data.row).length === 0) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Row must include at least one value' })
    }
    if (Object.keys(body.data.row).length > MAX_ROW_BODY) {
      throw new AppError({ code: 'PAYLOAD_TOO_LARGE', message: 'Row has too many columns' })
    }
    const result = await qs.insertRow({ ...body.data, maxRows: 1 })
    ctx.audit.write({
      userId: actorId(res),
      sessionId: String(res.locals.sessionRef),
      event: 'data.insert',
      status: 'ok',
      target: `${body.data.schema}.${body.data.table}`,
    })
    res.json({ result })
  })

  // PUT /api/data/rows — update rows by unambiguous identity
  router.put('/rows', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const { qs } = await primary(req, res)
    const body = z
      .object({
        ...rowMutationSchema.shape,
        identity: z.record(z.unknown()),
        identityColumns: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/)).min(1).max(4),
        changes: z.record(z.unknown()),
      })
      .safeParse(req.body)
    if (!body.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid update payload' })
    if (Object.keys(body.data.changes).length === 0) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'No changes provided for update' })
    }
    const result = await qs.updateRow(body.data)
    ctx.audit.write({
      userId: actorId(res),
      sessionId: String(res.locals.sessionRef),
      event: 'data.update',
      status: 'ok',
      target: `${body.data.schema}.${body.data.table}`,
      detail: `columns=${Object.keys(body.data.changes).join(',')}`,
    })
    res.json({ result })
  })

  // DELETE /api/data/rows — delete rows by unambiguous identity (destructive)
  router.delete('/rows', requireRecentAuth, async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const { qs } = await primary(req, res)
    const body = z
      .object({
        ...rowMutationSchema.shape,
        identity: z.record(z.unknown()),
        identityColumns: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/)).min(1).max(4),
      })
      .safeParse(req.body)
    if (!body.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid delete payload' })

    // Destructive confirmation + recent reauth are required.
    const confirmed = req.query.confirm === 'true' || (req.body as { confirm?: boolean })?.confirm === true
    if (!confirmed) {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Deleting rows requires explicit confirmation',
      })
    }

    const result = await qs.deleteRow(body.data)
    ctx.audit.write({
      userId: actorId(res),
      sessionId: String(res.locals.sessionRef),
      event: 'data.delete',
      status: 'ok',
      target: `${body.data.schema}.${body.data.table}`,
      detail: `rows=${result.rowCount ?? 0}`,
    })
    res.json({ result })
  })

  // POST /api/data/import — transactional bulk import
  router.post('/import', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const { qs } = await primary(req, res)
    const body = z
      .object({
        ...rowMutationSchema.shape,
        columns: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/)).min(1).max(60),
        rows: z.array(z.array(z.unknown())).min(1).max(10_000),
        batchSize: z.coerce.number().int().min(1).max(500).default(200),
        transactional: z.boolean().default(true),
      })
      .safeParse(req.body)
    if (!body.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid import payload' })
    if (body.data.columns.length === 0) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'At least one target column is required' })
    }
    const result = await qs.importRows(body.data)
    ctx.audit.write({
      userId: actorId(res),
      sessionId: String(res.locals.sessionRef),
      event: 'data.import',
      status: 'ok',
      target: `${body.data.schema}.${body.data.table}`,
      detail: `inserted=${result.inserted} failed=${result.failed}`,
    })
    res.json({ result })
  })

  // GET /api/data/stats — database stats (sizes, counts, connections)
  router.get('/stats', async (req: Request, res: Response) => {
    const { qs } = await primary(req, res)
    const stats = await qs.getStats()
    res.json({ stats })
  })

  // GET /api/data/roles & /grants — permission-aware introspection
  router.get('/roles', async (req: Request, res: Response) => {
    const { qs } = await primary(req, res)
    const roles = await qs.listRoles()
    res.json({ roles })
  })

  router.get('/grants', async (req: Request, res: Response) => {
    const { qs } = await primary(req, res)
    const schema = typeof req.query.schema === 'string' ? req.query.schema : undefined
    if (schema && !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(schema)) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid schema name' })
    }
    const grants = await qs.listGrants(schema)
    res.json({ grants })
  })

  return router
}