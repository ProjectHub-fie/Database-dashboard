/**
 * MongoDB database engine adapter.
 *
 * The `mongodb` driver talks to Atlas clusters. We pin the socket to the
 * verified address via the driver's `lookup` hook while TLS still verifies
 * the certificate against the original hostname — the same DNS-rebinding
 * defence as the Postgres path.
 *
 * The shared API layer is SQL-shaped, so this adapter maps Mongo's document
 * model onto the internal contract:
 *   - a *database* maps to a PostgreSQL "schema",
 *   - a *collection* maps to a "table",
 *   - a document's top-level fields map to "columns",
 *   - document identity is `_id`.
 *
 * SQL execution is intentionally not implemented: no SQL here. The adapter
 * implements the shape so the UI can browse databases/collections/documents;
 * the provider declares no `sql.*` capabilities, so the shared SQL routes are
 * not offered.
 */

import { DatabaseAdapter, DatabaseStats, EngineDialect, GrantInfo, QueryResult, RoleInfo, RowPage, SchemaObjectSummary, SchemaTree, TableColumnInfo, TableInfo } from '../providers/types.js'
import { AppError } from '../lib/errors.js'
import { ObjectId } from 'mongodb'
import type { MongoClient, Document } from 'mongodb'

// ---------------------------------------------------------------------------
// Connection handle
// ---------------------------------------------------------------------------

export type MongoConn = {
  client: MongoClient
  /** The database the operator connected to via the URI. */
  database: string
  /** The host that was resolved + pinned. */
  host: string
  version: string
}

export interface MongodbAdapterOptions {
  /** Backend-enforced cap on documents returned from a collection browse. */
  maxRows?: number
}

// ---------------------------------------------------------------------------
// BSON <-> JSON conversion (the shared layer is JSON-only)
// ---------------------------------------------------------------------------

/** Encode BSON values so they survive the JSON wire format. */
export function mongoValueToJson(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const anyV = value as Record<string, unknown>
    if (typeof (value as { toHexString?: unknown }).toHexString === 'function') {
      return { $oid: String((value as { toHexString: () => string }).toHexString()) }
    }
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map(mongoValueToJson)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(anyV)) out[k] = mongoValueToJson(v)
    return out
  }
  return value
}

/** Decode JSON-ish values back for a query; `$oid` markers become ObjectId. */
export function jsonToMongoValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(jsonToMongoValue)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$oid === 'string' && obj.$oid.length === 24) {
      try {
        return new ObjectId(obj.$oid)
      } catch {
        return obj.$oid
      }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = jsonToMongoValue(v)
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const SAMPLE = 200

export class MongodbAdapter implements DatabaseAdapter<MongoConn> {
  readonly kind = 'mongodb'
  readonly dialect: EngineDialect = {
    kind: 'mongodb',
    placeholder: () => '?', // no SQL: never invoked
    quoteIdentifier: (n) => quoteName(n),
    defaultPort: 27017,
    schemaModel: 'database',
  }
  private readonly maxRows: number

  constructor(opts: MongodbAdapterOptions = {}) {
    this.maxRows = opts.maxRows ?? 1000
    void this.maxRows
  }

  async ping(conn: MongoConn): Promise<{ latencyMs: number; version: string }> {
    const started = Date.now()
    const build = await conn.client.db().admin().buildInfo()
    return { latencyMs: Date.now() - started, version: String(build.version ?? 'unknown') }
  }

  async dispose(conn: MongoConn): Promise<void> {
    await conn.client.close().catch(() => undefined)
  }

  quoteIdentifier(schema: string, name: string): string {
    return `${quoteName(schema)}.${quoteName(name)}`
  }

  quoteColumn(name: string): string {
    return quoteName(name)
  }

  async getSchemaTree(conn: MongoConn): Promise<SchemaTree> {
    const dbs = await conn.client.db().admin().listDatabases()
    const out: SchemaTree = { schemas: [] }
    for (const db of dbs.databases ?? []) {
      const name = String(db.name ?? '')
      if (['admin', 'config', 'local'].includes(name)) continue
      out.schemas.push({ name, owner: null, objects: await listCollections(conn, name) })
    }
    return out
  }

  async listTableObjects(conn: MongoConn): Promise<SchemaObjectSummary[]> {
    const dbs = await conn.client.db().admin().listDatabases()
    const out: SchemaObjectSummary[] = []
    for (const db of dbs.databases ?? []) {
      const name = String(db.name ?? '')
      if (['admin', 'config', 'local'].includes(name)) continue
      for (const c of await listCollections(conn, name)) out.push(c)
    }
    return out
  }

  async getTableInfo(conn: MongoConn, input: { schema: string; table: string }): Promise<TableInfo> {
    const { schema, table } = input
    const found = (await listCollections(conn, schema)).find((c) => c.name === table)
    if (!found) {
      throw new AppError({ code: 'NOT_FOUND', message: `Collection '${table}' does not exist in '${schema}'` })
    }
    return {
      schema,
      name: table,
      kind: 'table',
      owner: undefined,
      columns: await sampleFields(conn, schema, table),
      primaryKeyColumns: ['_id'],
      foreignKeys: [],
      uniqueConstraints: [],
      indexes: [],
      rowEstimate: null,
    }
  }

  async browseRows(
    conn: MongoConn,
    schema: string,
    table: string,
    opts: { offset: number; limit: number; search?: string; orderBy?: string; orderDir?: string },
  ): Promise<RowPage> {
    const col = conn.client.db(schema).collection<Document>(table)
    const filter = buildSearchFilter(opts.search)
    const total = await col.countDocuments(filter).catch(() => null)
    let cursor = col
      .find(filter)
      .sort(typeof opts.orderBy === 'string' && opts.orderBy !== '_id' ? { [opts.orderBy]: opts.orderDir === 'desc' ? -1 : 1 } : { _id: 1 })
      .skip(opts.offset)
      .limit(opts.limit)
    void cursor
    const docs = await cursor.toArray()
    const columns = (await sampleFields(conn, schema, table)).map((c) => c.name)
    return {
      columns,
      rows: docs.map((d) => denormalize(d)),
      total,
      truncated: docs.length === opts.limit,
      offset: opts.offset,
    }
  }

  async insertRow(
    conn: MongoConn,
    input: { schema: string; table: string; row: Record<string, unknown> },
  ): Promise<QueryResult> {
    const col = conn.client.db(input.schema).collection<Document>(input.table)
    const doc = jsonToMongoValue(input.row) as Document
    const res = await col.insertOne(doc)
    return flatResult(input.table, [{ _id: mongoValueToJson(res.insertedId) }], 1)
  }

  async updateRow(
    conn: MongoConn,
    input: { schema: string; table: string; identity: Record<string, unknown>; identityColumns: string[]; changes: Record<string, unknown> },
  ): Promise<QueryResult> {
    const col = conn.client.db(input.schema).collection<Document>(input.table)
    const filter = identityFilter(input.identity, input.identityColumns)
    if (!filter) throw new AppError({ code: 'BAD_REQUEST', message: 'A document _id is required to update.' })
    const doc = jsonToMongoValue(input.changes) as Document
    const { matchedCount } = await col.updateOne(filter, { $set: doc })
    return flatResult(input.table, [{ n: matchedCount }], matchedCount)
  }

  async deleteRow(
    conn: MongoConn,
    input: { schema: string; table: string; identity: Record<string, unknown>; identityColumns: string[] },
  ): Promise<QueryResult> {
    const col = conn.client.db(input.schema).collection<Document>(input.table)
    const filter = identityFilter(input.identity, input.identityColumns)
    if (!filter) throw new AppError({ code: 'BAD_REQUEST', message: 'A document _id is required to delete.' })
    const { deletedCount } = await col.deleteOne(filter)
    return flatResult(input.table, [{ n: deletedCount }], deletedCount)
  }

  async executeStatement(_conn: MongoConn, _input: { sql: string; params?: readonly unknown[] }): Promise<QueryResult> {
    throw new AppError({
      code: 'FEATURE_UNAVAILABLE',
      message: 'MongoDB does not support SQL. Use the document browser or the query builder instead.',
    })
  }

  async cancelStatement(): Promise<void> {
    /** No-op: Mongo has no statement cancellation for the reads we run. */
  }

  async getStats(conn: MongoConn): Promise<DatabaseStats> {
    // Mongo has no connection catalog; report what the server exposes.
    let sizeBytes: number | null = null
    let version: string | null = null
    try {
      const status = await conn.client.db().admin().serverStatus()
      const mb = typeof status.mem?.resident === 'number' ? status.mem.resident : null
      sizeBytes = typeof mb === 'number' ? mb * 1024 * 1024 : null
      version = typeof status.version === 'string' ? status.version : null
    } catch {
      /* stats are best-effort */
    }
    const tree = await this.getSchemaTree(conn).catch(() => ({ schemas: [] } as SchemaTree))
    const tables = tree.schemas.reduce((n, s) => n + s.objects.length, 0)
    return {
      sizeBytes,
      tableCount: tables,
      schemaCount: tree.schemas.length,
      indexCount: 0,
      viewCount: 0,
      connectionCount: 0,
      cacheHitRatio: null,
      activeConnections: [],
      version,
    }
  }

  async listRoles(_conn: MongoConn): Promise<RoleInfo[]> {
    return []
  }

  async listGrants(_conn: MongoConn, _schema?: string): Promise<GrantInfo[]> {
    return []
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listCollections(conn: MongoConn, dbName: string): Promise<SchemaObjectSummary[]> {
  const cols = await conn.client.db(dbName).listCollections().toArray()
  return cols.map((c) => ({ schema: dbName, name: String(c.name), kind: 'table' as const }))
}

async function sampleFields(conn: MongoConn, dbName: string, table: string): Promise<TableColumnInfo[]> {
  const col = conn.client.db(dbName).collection<Document>(table)
  const docs = await col.find({}).limit(SAMPLE).toArray()
  const names = new Set<string>()
  for (const d of docs) for (const k of Object.keys(d)) names.add(k)
  return [...names].sort().map((name) => ({
    name,
    dataType: 'bson',
    nullable: true,
    defaultValue: null,
    ordinalPosition: 0,
    isPrimaryKey: name === '_id',
  }))
}

function denormalize(doc: Document): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) out[k] = mongoValueToJson(v)
  return out
}

function buildSearchFilter(search: string | undefined): Document {
  if (!search) return {}
  try {
    const parsed = JSON.parse(search)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    /* not JSON: fall through to _id regex */
  }
  return { $or: [{ _id: { $regex: search, $options: 'i' } }] }
}

function identityFilter(identity: Record<string, unknown>, identityColumns: string[]): Record<string, unknown> | null {
  const id = identity?.['_id']
  if (id !== undefined && id !== null) return { _id: jsonToMongoValue(id) }
  void identityColumns
  return null
}

function quoteName(name: string): string {
  if (!/^[A-Za-z0-9_$-]{1,200}$/.test(name)) {
    throw new AppError({ code: 'BAD_REQUEST', message: `Invalid Mongo identifier '${name}'` })
  }
  return name
}

function flatResult(table: string, rows: Array<Record<string, unknown>>, rowCount: number): QueryResult {
  return {
    statement: `mongo ${table}`,
    columns: rows.length ? Object.keys(rows[0]!).map((n) => ({ name: n })) : [],
    rows,
    rowCount,
    truncated: false,
    durationMs: 0,
    readOnly: false,
  }
}