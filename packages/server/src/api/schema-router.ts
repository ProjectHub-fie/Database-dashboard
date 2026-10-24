import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../lib/errors.js'
import { ctxOf } from './context.js'
import { actorId } from './middleware.js'

const ident = () => z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/).max(63)
const identOrQuoted = () => z.string().min(1).max(120)

const createTableSchema = z.object({
  schema: ident(),
  name: ident(),
  columns: z
    .array(
      z.object({
        name: ident(),
        type: z.string().min(1).max(60),
        nullable: z.boolean().default(true),
        default: z.string().max(200).nullable().optional(),
        primaryKey: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(64),
  ifNotExists: z.boolean().default(false),
  preview: z.boolean().default(false),
})

const addColumnSchema = z.object({
  schema: ident(),
  table: ident(),
  column: ident(),
  type: z.string().min(1).max(60),
  nullable: z.boolean().default(true),
  default: z.string().max(200).nullable().optional(),
  preview: z.boolean().default(false),
})

const renameColumnSchema = z.object({
  schema: ident(),
  table: ident(),
  oldName: ident(),
  newName: ident(),
  preview: z.boolean().default(false),
})

const createIndexSchema = z.object({
  schema: ident(),
  table: ident(),
  name: ident(),
  columns: z.array(identOrQuoted()).min(1).max(16),
  unique: z.boolean().default(false),
  concurrently: z.boolean().default(false),
  method: z.enum(['btree', 'hash', 'gin', 'gist', 'brin']).optional(),
  preview: z.boolean().default(false),
})

const createSchemaSchema = z.object({
  name: ident(),
  authorization: ident().optional(),
  preview: z.boolean().default(false),
})

const createForeignKeySchema = z.object({
  schema: ident(),
  table: ident(),
  name: ident(),
  column: ident(),
  referencedSchema: ident().default('public'),
  referencedTable: ident(),
  referencedColumn: ident(),
  onDelete: z.enum(['no action', 'restrict', 'cascade', 'set null', 'set default']).optional(),
  onUpdate: z.enum(['no action', 'restrict', 'cascade', 'set null', 'set default']).optional(),
  preview: z.boolean().default(false),
})

/**
 * Schema Manager. DDL statements are executed through the same bounded query
 * session as everything else. Destructive operations require `confirm` and are
 * always reported to the audit log. Preview mode returns the generated SQL
 * without touching the database.
 */
export function schemaRouter(): Router {
  const router = Router()

  function primary(req: Request, res: Response) {
    const ctx = ctxOf(req)
    return ctx.providerSessions.allocatePrimary(
      String(res.locals.sessionRef ?? ''),
      actorId(res),
    )
  }

  function writeAudit(req: Request, res: Response, event: string, detail: string, target?: string): void {
    ctxOf(req).audit.write({
      userId: actorId(res),
      sessionId: String(res.locals.sessionRef),
      event,
      status: 'ok',
      target,
      detail,
    })
  }

  // POST /api/schema/tables
  router.post('/tables', async (req: Request, res: Response) => {
    const parsed = createTableSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid table payload' })
    const { schema, name, columns, ifNotExists, preview } = parsed.data
    const defs = columns
      .map((c) => {
        let d = `  ${quote(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}`
        if (c.default) d += ` DEFAULT ${c.default}`
        return d
      })
      .join(',\n')
    const pk = columns.filter((c) => c.primaryKey).map((c) => quote(c.name))
    const parts = [defs]
    if (pk.length) parts.push(`  PRIMARY KEY (${pk.join(', ')})`)
    const sql = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${qual(schema, name)} (\n${parts.join(',\n')}\n)`
    if (preview) {
      res.json({ sql, preview: true })
      return
    }
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.create_table', `sql=${sql}`, `${schema}.${name}`)
    res.json({ ok: true })
  })

  // DELETE /api/schema/tables/:schema/:table?confirm=&cascade=&preview=
  router.delete('/tables/:schema/:table', async (req: Request, res: Response) => {
    const schema = String(req.params.schema ?? '')
    const table = String(req.params.table ?? '')
    if (!ident().safeParse(schema).success || !ident().safeParse(table).success) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid table name' })
    }
    const confirm = req.query.confirm === 'true'
    const cascade = req.query.cascade === 'true'
    const preview = req.query.preview === 'true'
    if (preview) {
      res.json({ sql: `DROP TABLE ${qual(schema, table)}${cascade ? ' CASCADE' : ''}`, preview: true })
      return
    }
    if (!confirm) {
      throw new AppError({ code: 'FORBIDDEN', message: 'Dropping a table requires explicit confirmation' })
    }
    const sql = `DROP TABLE ${qual(schema, table)}${cascade ? ' CASCADE' : ''}`
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.drop_table', `sql=${sql}`, `${schema}.${table}`)
    res.json({ ok: true })
  })

  // POST /api/schema/columns  (add)
  router.post('/columns', async (req: Request, res: Response) => {
    const parsed = addColumnSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid column payload' })
    const { schema, table, column, type, nullable, default: dflt, preview } = parsed.data
    let def = `${quote(column)} ${type}${nullable ? '' : ' NOT NULL'}`
    if (dflt) def += ` DEFAULT ${dflt}`
    const sql = `ALTER TABLE ${qual(schema, table)} ADD COLUMN ${def}`
    if (preview) {
      res.json({ sql, preview: true })
      return
    }
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.add_column', `sql=${sql}`, `${schema}.${table}`)
    res.json({ ok: true })
  })

  // POST /api/schema/columns/rename
  router.post('/columns/rename', async (req: Request, res: Response) => {
    const parsed = renameColumnSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid rename payload' })
    const { schema, table, oldName, newName, preview } = parsed.data
    const sql = `ALTER TABLE ${qual(schema, table)} RENAME COLUMN ${quote(oldName)} TO ${quote(newName)}`
    if (preview) {
      res.json({ sql, preview: true })
      return
    }
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.rename_column', `sql=${sql}`, `${schema}.${table}`)
    res.json({ ok: true })
  })

  // DELETE /api/schema/columns/:schema/:table/:column?confirm=
  router.delete('/columns/:schema/:table/:column', async (req: Request, res: Response) => {
    const schema = String(req.params.schema ?? '')
    const table = String(req.params.table ?? '')
    const column = String(req.params.column ?? '')
    if (!ident().safeParse(schema).success || !ident().safeParse(table).success || !ident().safeParse(column).success) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid column name' })
    }
    const confirm = req.query.confirm === 'true'
    const preview = req.query.preview === 'true'
    if (preview) {
      res.json({ sql: `ALTER TABLE ${qual(schema, table)} DROP COLUMN ${quote(column)}`, preview: true })
      return
    }
    if (!confirm) {
      throw new AppError({ code: 'FORBIDDEN', message: 'Dropping a column requires explicit confirmation' })
    }
    const sql = `ALTER TABLE ${qual(schema, table)} DROP COLUMN ${quote(column)}`
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.drop_column', `sql=${sql}`, `${schema}.${table}.${column}`)
    res.json({ ok: true })
  })

  // POST /api/schema/indexes
  router.post('/indexes', async (req: Request, res: Response) => {
    const parsed = createIndexSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid index payload' })
    const { schema, table, name, columns, unique, concurrently, method, preview } = parsed.data
    const prefix = `${unique ? 'UNIQUE ' : ''}INDEX ${concurrently ? 'CONCURRENTLY ' : ''}`
    const using = method ? ` USING ${method}` : ''
    const sql = `CREATE ${prefix}${quote(name)} ON ${qual(schema, table)}${using} (${columns.map((c) => quote(c)).join(', ')})`
    if (preview) {
      res.json({ sql, preview: true })
      return
    }
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.create_index', `sql=${sql}`, `${schema}.${table}`)
    res.json({ ok: true })
  })

  // DELETE /api/schema/indexes/:schema/:name?confirm=
  router.delete('/indexes/:schema/:name', async (req: Request, res: Response) => {
    const schema = String(req.params.schema ?? '')
    const name = String(req.params.name ?? '')
    if (!ident().safeParse(schema).success || !ident().safeParse(name).success) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid index name' })
    }
    const confirm = req.query.confirm === 'true'
    const preview = req.query.preview === 'true'
    if (preview) {
      res.json({ sql: `DROP INDEX ${qual(schema, name)}`, preview: true })
      return
    }
    if (!confirm) {
      throw new AppError({ code: 'FORBIDDEN', message: 'Dropping an index requires explicit confirmation' })
    }
    const sql = `DROP INDEX ${qual(schema, name)}`
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.drop_index', `sql=${sql}`, `${schema}.${name}`)
    res.json({ ok: true })
  })

  // POST /api/schema/create (schemas)
  router.post('/create', async (req: Request, res: Response) => {
    const parsed = createSchemaSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid schema payload' })
    const { name, authorization, preview } = parsed.data
    const sql = `CREATE SCHEMA ${quote(name)}${authorization ? ` AUTHORIZATION ${quote(authorization)}` : ''}`
    if (preview) {
      res.json({ sql, preview: true })
      return
    }
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.create_schema', `sql=${sql}`, name)
    res.json({ ok: true })
  })

  // POST /api/schema/foreign-keys
  router.post('/foreign-keys', async (req: Request, res: Response) => {
    const parsed = createForeignKeySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid foreign key payload' })
    const { schema, table, name, column, referencedSchema, referencedTable, referencedColumn, onDelete, onUpdate, preview } =
      parsed.data
    const actions = [
      onDelete ? `ON DELETE ${onDelete.toUpperCase()}` : '',
      onUpdate ? `ON UPDATE ${onUpdate.toUpperCase()}` : '',
    ].filter(Boolean)
    const sql = `ALTER TABLE ${qual(schema, table)} ADD CONSTRAINT ${quote(name)} FOREIGN KEY (${quote(column)}) REFERENCES ${qual(referencedSchema, referencedTable)} (${quote(referencedColumn)})${actions.length ? ` ${actions.join(' ')}` : ''}`
    if (preview) {
      res.json({ sql, preview: true })
      return
    }
    await (await primary(req, res)).qs.execute({ sql }, { statementTimeoutMs: 60_000 })
    writeAudit(req, res, 'schema.create_foreign_key', `sql=${sql}`, `${schema}.${table}`)
    res.json({ ok: true })
  })

  return router
}

/** Always-quote identifiers; never interpolate raw names into SQL. */
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function qual(schema: string, name: string): string {
  return `${quote(schema)}.${quote(name)}`
}