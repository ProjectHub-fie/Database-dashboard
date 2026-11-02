/**
 * QuerySession for MongoDB connections.
 *
 * The shared `QuerySession` interface is SQL-shaped; Mongo has no SQL. This
 * implementation maps only what the data-browser routes actually use onto
 * Mongo operations and throws a graceful FEATURE_UNAVAILABLE for everything
 * that requires SQL. Because the Mongo provider declares no `sql.*`
 * capabilities, the shared SQL routes are not advertised to the UI.
 */

import {
  DatabaseStats,
  GrantInfo,
  QueryResult,
  QuerySession,
  RoleInfo,
  RowPage,
  SchemaObjectSummary,
  SchemaTree,
  TableInfo,
} from '../providers/types.js'
import { AppError } from '../lib/errors.js'
import { MongodbAdapter, MongoConn } from './mongodb.js'

export class MongoQuerySession implements QuerySession {
  readonly readOnly = false

  constructor(
    private readonly conn: MongoConn,
    private readonly adapter: MongodbAdapter,
  ) {}

  get mongo() {
    return this.conn.client
  }

  async execute(): Promise<QueryResult> {
    throw new AppError({
      code: 'FEATURE_UNAVAILABLE',
      message: 'MongoDB does not support SQL. Use the document browser instead.',
    })
  }

  async cancel(): Promise<void> {
    /** No-op: nothing to cancel on Mongo reads. */
  }

  async beginTransaction(): Promise<void> {
    throw new AppError({ code: 'FEATURE_UNAVAILABLE', message: 'MongoDB transactions are not exposed in this dashboard yet.' })
  }

  async commitTransaction(): Promise<void> {
    throw new AppError({ code: 'FEATURE_UNAVAILABLE', message: 'MongoDB transactions are not exposed in this dashboard yet.' })
  }

  async rollbackTransaction(): Promise<void> {
    throw new AppError({ code: 'FEATURE_UNAVAILABLE', message: 'MongoDB transactions are not exposed in this dashboard yet.' })
  }

  async close(): Promise<void> {
    // Lifecycle of the client is owned by the provider connection ref.
  }

  getSchemaTree(): Promise<SchemaTree> {
    return this.adapter.getSchemaTree(this.conn)
  }

  listTableObjects(): Promise<SchemaObjectSummary[]> {
    return this.adapter.listTableObjects(this.conn)
  }

  getTableInfo(input: { schema: string; table: string }): Promise<TableInfo> {
    return this.adapter.getTableInfo(this.conn, input)
  }

  browseRows(schema: string, table: string, opts: { offset: number; limit: number; orderBy?: string; orderDir?: string; search?: string }): Promise<RowPage> {
    return this.adapter.browseRows(this.conn, schema, table, opts)
  }

  async exportTableRows(input: { schema: string; table: string; maxRows: number; orderBy?: string; orderDir?: 'asc' | 'desc'; search?: string }): Promise<{
    columns: string[]
    rows: AsyncIterable<Record<string, unknown>>
    truncated: boolean
    rowCount: number
    maxRows: number
  }> {
    // Stream-limit to maxRows to keep export bounded.
    const limit = Math.max(1, Math.min(input.maxRows, 100_000))
    const batch = await this.adapter.browseRows(this.conn, input.schema, input.table, {
      offset: 0,
      limit,
      orderBy: input.orderBy,
      orderDir: input.orderDir,
      search: input.search,
    })
    return {
      columns: batch.columns,
      rows: (async function* () {
        for (const row of batch.rows) yield row
      })(),
      truncated: batch.truncated,
      rowCount: batch.rows.length,
      maxRows: limit,
    }
  }

  insertRow(input: { schema: string; table: string; row: Record<string, unknown>; maxRows?: number }): Promise<QueryResult> {
    return this.adapter.insertRow(this.conn, input)
  }

  updateRow(input: {
    schema: string
    table: string
    identity: Record<string, unknown>
    identityColumns: string[]
    changes: Record<string, unknown>
  }): Promise<QueryResult> {
    return this.adapter.updateRow(this.conn, input)
  }

  deleteRow(input: {
    schema: string
    table: string
    identity: Record<string, unknown>
    identityColumns: string[]
  }): Promise<QueryResult> {
    return this.adapter.deleteRow(this.conn, input)
  }

  getStats(): Promise<DatabaseStats> {
    return this.adapter.getStats(this.conn)
  }

  listRoles(): Promise<RoleInfo[]> {
    return this.adapter.listRoles(this.conn)
  }

  listGrants(_schema?: string): Promise<GrantInfo[]> {
    return this.adapter.listGrants(this.conn)
  }

  async importRows(_input: {
    schema: string
    table: string
    columns: string[]
    rows: Array<Array<unknown>>
    batchSize: number
    transactional: boolean
  }): Promise<{ inserted: number; failed: number; errors: Array<{ row: number; message: string }> }> {
    throw new AppError({
      code: 'FEATURE_UNAVAILABLE',
      message: 'CSV/JSON import into MongoDB collections is not supported yet. Use the Atlas UI or a driver script.',
    })
  }
}