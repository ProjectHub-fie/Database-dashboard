import pg from 'pg'
import { Duplex } from 'node:stream'
import crypto from 'node:crypto'
import {
  QuerySession,
  QueryResult,
  SqlExecutionOptions,
  SchemaTree,
  SchemaObjectSummary,
  TableInfo,
  RowPage,
  DatabaseStats,
  RoleInfo,
  GrantInfo,
} from '../providers/types.js'
import { PostgresAdapter, PgConn } from './postgres.js'
import { AppError } from '../lib/errors.js'

const { Pool } = pg

export interface QuerySessionOptions {
  maxRows?: number
  statementTimeoutMs?: number
  buildCancellationConnection?: (opts: { conn: PgConn; applicationName: string }) => pg.Pool
}

/**
 * A query session executes sequentially over the provider's pinned,
 * TLS-verified single connection. Statement timeouts and row caps are
 * enforced by the backend; the client cannot disable them.
 */
export class PgQuerySession implements QuerySession {
  private pid: number | null = null
  private readonly cancelPool: pg.Pool
  private closed = false
  private transactionDepth = 0

  constructor(
    private readonly conn: PgConn,
    private readonly adapter: PostgresAdapter,
    private readonly opts: QuerySessionOptions = {},
  ) {
    this.cancelPool = opts.buildCancellationConnection
      ? opts.buildCancellationConnection({ conn, applicationName: 'db-remote-cancel' })
      : buildSharedPool(conn, 'db-remote-cancel')
    this.conn.client
      .query('SELECT pg_backend_pid() AS pid')
      .then((r) => {
        this.pid = Number(r.rows[0]?.pid ?? 0)
      })
      .catch(() => {
        this.pid = null
      })
  }

  get readOnly(): boolean {
    return this.conn.role === 'readonly' // readOnly is role-derived, never a UI toggle
  }

  async execute(input: { sql: string; params?: readonly unknown[] }, o?: SqlExecutionOptions): Promise<QueryResult> {
    if (this.closed) {
      throw new AppError({ code: 'CONNECTION_FAILED', message: 'Query session is closed' })
    }
    return this.adapter.executeStatement(this.conn, input, {
      maxRows: o?.maxRows ?? this.opts.maxRows,
      statementTimeoutMs: o?.statementTimeoutMs ?? this.opts.statementTimeoutMs,
    })
  }

  async cancel(runId: string): Promise<void> {
    void runId
    if (!this.pid) return
    const client = await this.cancelPool.connect().catch(() => null)
    if (!client) return
    try {
      await client.query('SELECT pg_cancel_backend($1) AS cancelled', [this.pid])
    } catch {
      // cancellation is best-effort
    } finally {
      client.release()
    }
  }

  // ---- data browser passthroughs ------------------------------------------

  getSchemaTree(): Promise<SchemaTree> {
    return this.adapter.getSchemaTree(this.conn)
  }

  listTableObjects(): Promise<SchemaObjectSummary[]> {
    return this.adapter.listTableObjects(this.conn)
  }

  getTableInfo(input: { schema: string; table: string }): Promise<TableInfo> {
    return this.adapter.getTableInfo(this.conn, input)
  }

  browseRows(
    schema: string,
    table: string,
    opts: { offset: number; limit: number; orderBy?: string; orderDir?: string; search?: string },
  ): Promise<RowPage> {
    const searchFilter = opts.search
      ? [{ column: '*', op: 'contains' as const, value: opts.search }]
      : undefined
    return this.adapter.readRows(this.conn, {
      schema,
      table,
      limit: opts.limit,
      offset: opts.offset,
      orderBy: opts.orderBy,
      orderDir: opts.orderDir === 'desc' ? 'desc' : 'asc',
      filters: searchFilter,
    })
  }

  exportTableRows(input: {
    schema: string
    table: string
    maxRows: number
    orderBy?: string
    orderDir?: 'asc' | 'desc'
    search?: string
  }): Promise<{
    columns: string[]
    rows: AsyncIterable<Record<string, unknown>>
    truncated: boolean
    rowCount: number
    maxRows: number
  }> {
    const searchFilter = input.search
      ? [{ column: '*', op: 'contains' as const, value: input.search }]
      : undefined
    return this.adapter
      .exportTableRows(this.conn, {
        schema: input.schema,
        table: input.table,
        maxRows: input.maxRows,
        orderBy: input.orderBy,
        orderDir: input.orderDir,
        filters: searchFilter,
      })
      .then((r) => ({ ...r, maxRows: input.maxRows }))
  }

  insertRow(input: { schema: string; table: string; row: Record<string, unknown>; maxRows?: number }): Promise<QueryResult> {
    if (this.readOnly) {
      throw new AppError({ code: 'FORBIDDEN', message: 'This connection is read-only (role-derived permissions)' })
    }
    return this.adapter.insertRow(this.conn, input)
  }

  updateRow(input: {
    schema: string
    table: string
    identity: Record<string, unknown>
    identityColumns: string[]
    changes: Record<string, unknown>
  }): Promise<QueryResult> {
    if (this.readOnly) {
      throw new AppError({ code: 'FORBIDDEN', message: 'This connection is read-only (role-derived permissions)' })
    }
    return this.adapter.updateRow(this.conn, input)
  }

  deleteRow(input: {
    schema: string
    table: string
    identity: Record<string, unknown>
    identityColumns: string[]
  }): Promise<QueryResult> {
    if (this.readOnly) {
      throw new AppError({ code: 'FORBIDDEN', message: 'This connection is read-only (role-derived permissions)' })
    }
    return this.adapter.deleteRow(this.conn, input)
  }

  getStats(): Promise<DatabaseStats> {
    return this.adapter.getStats(this.conn)
  }

  listRoles(): Promise<RoleInfo[]> {
    return this.adapter.listRoles(this.conn)
  }

  listGrants(schema?: string): Promise<GrantInfo[]> {
    return this.adapter.listGrants(this.conn, schema)
  }

  importRows(input: {
    schema: string
    table: string
    columns: string[]
    rows: Array<Array<unknown>>
    batchSize: number
    transactional: boolean
  }): Promise<{ inserted: number; failed: number; errors: Array<{ row: number; message: string }> }> {
    if (this.readOnly) {
      throw new AppError({ code: 'FORBIDDEN', message: 'This connection is read-only (role-derived permissions)' })
    }
    if (!this.adapter.importRows) {
      throw new AppError({ code: 'NOT_IMPLEMENTED', message: 'This provider does not support bulk import' })
    }
    return this.adapter.importRows(this.conn, input)
  }

  async beginTransaction(opts: { readOnly?: boolean; isolation?: 'read committed' | 'repeatable read' } = {}): Promise<void> {
    if (this.transactionDepth > 0) {
      throw new AppError({ code: 'CONFLICT', message: 'A transaction is already open on this session' })
    }
    const parts: string[] = []
    if (opts.readOnly) parts.push('READ ONLY')
    if (opts.isolation) parts.push(`ISOLATION LEVEL ${opts.isolation.toUpperCase()}`)
    await this.conn.client.query(`BEGIN${parts.length ? ` ${parts.join(' ')}` : ''}`)
    this.transactionDepth = 1
  }

  async commitTransaction(): Promise<void> {
    if (this.transactionDepth <= 0) return
    await this.conn.client.query('COMMIT')
    this.transactionDepth = 0
  }

  async rollbackTransaction(): Promise<void> {
    if (this.transactionDepth <= 0) return
    await this.conn.client.query('ROLLBACK')
    this.transactionDepth = 0
  }

  get inTransaction(): boolean {
    return this.transactionDepth > 0
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.transactionDepth > 0) {
      await this.conn.client.query('ROLLBACK').catch(() => undefined)
      this.transactionDepth = 0
    }
    await this.cancelPool.end().catch(() => undefined)
  }
}

/** A one-connection pool sharing the same pinned, TLS-verified socket config. */
function buildSharedPool(conn: PgConn, applicationName: string): pg.Pool {
  const opts = conn.clientOptions
  return new Pool({
    host: opts.host,
    port: opts.port,
    database: opts.database,
    user: opts.user,
    password: opts.password,
    application_name: applicationName,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis,
    ssl: opts.ssl,
    stream: opts.stream as (config?: unknown) => Duplex,
  })
}

export function newRunId(): string {
  return crypto.randomBytes(8).toString('hex')
}
