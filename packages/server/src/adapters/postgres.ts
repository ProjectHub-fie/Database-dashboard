import pg from 'pg'
import {
  DatabaseAdapter,
  DatabaseStats,
  GrantInfo,
  QueryResult,
  RoleInfo,
  RowPage,
  SchemaObjectSummary,
  SchemaTree,
  TableColumnInfo,
  TableForeignKey,
  TableIndex,
  TableInfo,
} from '../providers/types.js'
import { quoteQualified } from './sql-ident.js'
import { redact } from '../lib/redact.js'
import { AppError } from '../lib/errors.js'
import { createPinnedSocket } from './pinned-socket.js'

const { Client } = pg

export type PgConn = {
  client: pg.Client
  role: string
  database: string
  pinnedAddress: string
  /** TLS options (with `stream` factory) held here so cancel/export pools reuse the same pin. */
  clientOptions: {
    host: string
    port: number
    database: string
    user: string
    password: string
    ssl: pg.ClientConfig['ssl']
    stream: unknown
    connectionTimeoutMillis: number
    applicationName: string
  }
}

const STATEMENT_TIMEOUT_MS = 15_000
const MAX_RESULT_ROWS = Number(process.env.MAX_RESULT_ROWS ?? 1_000)

export interface PostgresAdapterOptions {
  /** Backend enforced caps. */
  maxRows?: number
  statementTimeoutMs?: number
}

/**
 * PostgreSQL database engine adapter shared by any PostgreSQL-compatible cloud
 * provider (Neon, Supabase, RDS, ...). All values are parameterized; all
 * identifiers must flow through `quoteQualified`.
 */
export class PostgresAdapter implements DatabaseAdapter<PgConn> {
  readonly kind = 'postgres'
  private readonly maxRows: number
  private readonly statementTimeoutMs: number

  constructor(opts: PostgresAdapterOptions = {}) {
    this.maxRows = opts.maxRows ?? MAX_RESULT_ROWS
    this.statementTimeoutMs = opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS
  }

  get defaultStatementTimeoutMs(): number {
    return this.statementTimeoutMs
  }

  async ping(conn: PgConn): Promise<{ latencyMs: number; version: string }> {
    const started = Date.now()
    const { rows } = await conn.client.query<{ version: string }>('SELECT version() AS version')
    return { latencyMs: Date.now() - started, version: rows[0]?.version ?? 'unknown' }
  }

  async dispose(conn: PgConn): Promise<void> {
    await conn.client.end().catch(() => undefined)
  }

  quoteIdentifier(schema: string, name: string): string {
    return quoteQualified(schema, name)
  }

  quoteColumn(name: string): string {
    return quoteQualified('public', name).replace(/^"public"\./, '')
  }

  async executeStatement(
    conn: PgConn,
    input: { sql: string; params?: readonly unknown[] },
    opts?: { maxRows?: number; statementTimeoutMs?: number },
  ): Promise<QueryResult> {
    const maxRows = opts?.maxRows ?? this.maxRows
    const timeoutMs = opts?.statementTimeoutMs ?? this.statementTimeoutMs
    const started = Date.now()
    let sql = input.sql

    let truncated = false
    // Enforce a row cap on the server for SELECT-shaped statements.
    const isRowReturning = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:select|with|show|explain|describe|values|table)\b/i.test(sql)
    if (isRowReturning) {
      const wrapped = `${sql.trim().replace(/;+\s*$/, '')} LIMIT ${maxRows + 1}`
      if (wrapped !== `${input.sql.trim().replace(/;+\s*$/, '')}`) {
        sql = wrapped
      }
    }

    let result
    try {
      // Enforce the timeout server-side so PostgreSQL cancels the statement,
      // not just the node driver. The value comes from the backend, never the
      // client.
      await conn.client.query(`SET statement_timeout = ${Math.max(1, timeoutMs)}`)
      result = await conn.client.query({
        text: sql,
        values: input.params ? [...input.params] : [],
      })
    } catch (err) {
      throw this.translatePgError(err)
    } finally {
      await conn.client.query('SET statement_timeout = 0').catch(() => undefined)
    }
    if ((result.rowCount ?? 0) > maxRows) truncated = true

    const durationMs = Date.now() - started
    return {
      statement: input.sql,
      columns: result.fields.map((f) => ({ name: f.name, typeOid: f.dataTypeID })),
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount,
      truncated,
      durationMs,
      readOnly: this.isReadOnlyStatement(input.sql),
    }
  }

  async cancelStatement(_conn: PgConn, _runId: string): Promise<void> {
    // Cancellation is implemented in PgQuerySession.cancel which targets the
    // session's backend pid over a dedicated pinned pool.
  }

  async getSchemaTree(conn: PgConn): Promise<SchemaTree> {
    const client = conn.client
    const q = String.raw`
      SELECT n.nspname AS schema,
             n.nspowner::regrole::text AS owner
      FROM pg_catalog.pg_namespace n
      WHERE n.nspname NOT LIKE 'pg\_%'
        AND n.nspname <> 'information_schema'
      ORDER BY n.nspname`
    const schemas = (await client.query(q)).rows as Array<{ schema: string; owner: string }>

    const objects = (await client.query(TABLE_OBJECTS_SQL)).rows as Array<{
      schema: string
      name: string
      kind: string
    }>

    return {
      schemas: schemas.map((s) => ({
        name: s.schema,
        owner: s.owner,
        objects: objects
          .filter((o) => o.schema === s.schema)
          .map((o) => ({
            schema: o.schema,
            name: o.name,
            kind: o.kind as SchemaObjectSummary['kind'],
          })),
      })),
    }
  }

  async listTableObjects(conn: PgConn): Promise<SchemaObjectSummary[]> {
    const rows = (await conn.client.query(TABLE_OBJECTS_SQL)).rows as Array<{
      schema: string
      name: string
      kind: string
    }>
    return rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: r.kind as SchemaObjectSummary['kind'],
    }))
  }

  async getTableInfo(conn: PgConn, input: { schema: string; table: string }): Promise<TableInfo> {
    const client = conn.client

    // kind + owner + row estimate
    const meta = (
      await client.query(
        String.raw`SELECT c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner,
                          c.reltuples::bigint AS row_estimate
                   FROM pg_catalog.pg_class c
                   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = $1 AND c.relname = $2`,
        [input.schema, input.table],
      )
    ).rows[0] as { kind: string; owner: string; row_estimate: number } | undefined

    if (!meta) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: `Table '${input.schema}.${input.table}' was not found`,
      })
    }

    const columns = await this.loadColumns(client, input.schema, input.table)
    const primaryKeyColumns = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
    const foreignKeys = await this.loadForeignKeys(client, input.schema, input.table)
    const uniqueConstraints = await this.loadUniqueConstraints(client, input.schema, input.table)
    const indexes = await this.loadIndexes(client, input.schema, input.table)

    return {
      schema: input.schema,
      name: input.table,
      kind: normalizeKind(meta.kind),
      owner: meta.owner,
      columns,
      primaryKeyColumns,
      foreignKeys,
      uniqueConstraints,
      indexes,
      rowEstimate: meta.row_estimate === -1 ? null : meta.row_estimate,
    }
  }

  async readRows(
    conn: PgConn,
    input: {
      schema: string
      table: string
      limit: number
      offset: number
      orderBy?: string
      orderDir?: 'asc' | 'desc'
      filters?: Array<{ column: string; op: string; value: unknown }>
    },
  ): Promise<RowPage> {
    const client = conn.client
    const table = quoteQualified(input.schema, input.table)
    const whereSql: string[] = []
    const params: unknown[] = []

    // Cache of quoted column names for the '*' pseudo-column (all text columns).
    let allTextColumns: string[] | null = null

    for (const f of input.filters ?? []) {
      if (f.column === '*') {
        // Search across every text-ish column. The column list comes from the
        // catalog (trusted names), values are parameterized.
        if (!allTextColumns) {
          const cols = await this.loadColumns(client, input.schema, input.table)
          allTextColumns = cols
            .filter(
              (c) =>
                /char|text|json|uuid|inet|citext|numeric|int|bool|date|time|timestamp|bytea/i.test(
                  c.dataType,
                ),
            )
            .map((c) => c.name)
        }
        if (allTextColumns.length === 0) {
          whereSql.push('1 = 0')
          continue
        }
        const needle = `%${String(f.value)}%`
        const searchExprs = allTextColumns
          .map((c) => {
            params.push(needle)
            return `${this.quoteColumn(c)}::text ILIKE $${params.length}`
          })
          .join(' OR ')
        whereSql.push(`(${searchExprs})`)
        continue
      }
      const col = this.quoteColumn(f.column)
      if (f.op === 'ilike') {
        params.push(`%${String(f.value)}%`)
        whereSql.push(`${col}::text ILIKE $${params.length}`)
      } else if (f.op === 'eq') {
        params.push(f.value)
        whereSql.push(`${col} = $${params.length}`)
      } else if (f.op === 'neq') {
        params.push(f.value)
        whereSql.push(`${col} <> $${params.length}`)
      } else if (f.op === 'gt') {
        params.push(f.value)
        whereSql.push(`${col} > $${params.length}`)
      } else if (f.op === 'lt') {
        params.push(f.value)
        whereSql.push(`${col} < $${params.length}`)
      } else if (f.op === 'contains') {
        params.push(`%${String(f.value)}%`)
        whereSql.push(`${col}::text ILIKE $${params.length}`)
      } else if (f.op === 'null') {
        whereSql.push(`${col} IS NULL`)
      } else if (f.op === 'not-null') {
        whereSql.push(`${col} IS NOT NULL`)
      } else {
        throw new AppError({ code: 'BAD_REQUEST', message: `Unsupported filter operator '${f.op}'` })
      }
    }

    const orderByClause =
      input.orderBy && /^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/.test(input.orderBy)
        ? ` ORDER BY ${this.quoteColumn(input.orderBy)} ${input.orderDir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`
        : ''

    const where = whereSql.length > 0 ? ` WHERE ${whereSql.join(' AND ')}` : ''
    const countParams = [...params]
    const totalQuery = `SELECT COUNT(*)::bigint AS total FROM ${table}${where}`
    const total = (await client.query(totalQuery, countParams)).rows[0] as { total: number }

    const rowParams = [...params, input.limit, input.offset]
    const rowsSql = `SELECT * FROM ${table}${where}${orderByClause} LIMIT $${rowParams.length - 1}::int OFFSET $${rowParams.length}::int`
    const res = await client.query({ text: rowsSql, values: rowParams })
    return {
      columns: res.fields.map((f) => f.name),
      rows: res.rows as Array<Record<string, unknown>>,
      total: total.total,
      truncated: res.rows.length >= input.limit,
      offset: input.offset,
    }
  }

  async insertRow(
    conn: PgConn,
    input: {
      schema: string
      table: string
      row: Record<string, unknown>
    },
  ): Promise<QueryResult> {
    const columns = Object.keys(input.row)
    if (columns.length === 0) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'No values provided for insert' })
    }
    const quoted = columns.map((c) => this.quoteColumn(c)).join(', ')
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
    const values = columns.map((c) => input.row[c])
    const sql = `INSERT INTO ${quoteQualified(input.schema, input.table)} (${quoted}) VALUES (${placeholders}) RETURNING *`
    const res = await conn.client.query({ text: sql, values })
    return {
      statement: sql,
      columns: res.fields.map((f) => ({ name: f.name })),
      rows: res.rows as Array<Record<string, unknown>>,
      rowCount: res.rowCount,
      truncated: false,
      durationMs: 0,
      readOnly: false,
    }
  }

  async updateRow(
    conn: PgConn,
    input: {
      schema: string
      table: string
      identity: Record<string, unknown>
      identityColumns: string[]
      changes: Record<string, unknown>
    },
  ): Promise<QueryResult> {
    const changeCols = Object.keys(input.changes)
    if (changeCols.length === 0) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'No values provided for update' })
    }
    const setClauses = changeCols.map((c, i) => `${this.quoteColumn(c)} = $${i + 1}`)
    const begin = changeCols.length
    const whereClauses = input.identityColumns.map((c, i) => {
      const idx = begin + i + 1
      return `${this.quoteColumn(c)} = $${idx}`
    })
    const values = [...changeCols.map((c) => input.changes[c]), ...input.identityColumns.map((c) => input.identity[c])]
    const sql = `UPDATE ${quoteQualified(input.schema, input.table)} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')} RETURNING *`
    const res = await conn.client.query({ text: sql, values })
    return {
      statement: sql,
      columns: res.fields.map((f) => ({ name: f.name })),
      rows: res.rows as Array<Record<string, unknown>>,
      rowCount: res.rowCount,
      truncated: false,
      durationMs: 0,
      readOnly: false,
    }
  }

  async deleteRow(
    conn: PgConn,
    input: {
      schema: string
      table: string
      identity: Record<string, unknown>
      identityColumns: string[]
    },
  ): Promise<QueryResult> {
    const whereClauses = input.identityColumns.map((c, i) => {
      return `${this.quoteColumn(c)} = $${i + 1}`
    })
    const values = input.identityColumns.map((c) => input.identity[c])
    const sql = `DELETE FROM ${quoteQualified(input.schema, input.table)} WHERE ${whereClauses.join(' AND ')} RETURNING *`
    const res = await conn.client.query({ text: sql, values })
    return {
      statement: sql,
      columns: res.fields.map((f) => ({ name: f.name })),
      rows: res.rows as Array<Record<string, unknown>>,
      rowCount: res.rowCount,
      truncated: false,
      durationMs: 0,
      readOnly: false,
    }
  }

  async importRows(
    conn: PgConn,
    input: {
      schema: string
      table: string
      columns: string[]
      rows: Array<Array<unknown>>
      batchSize: number
      transactional: boolean
    },
  ): Promise<{ inserted: number; failed: number; errors: Array<{ row: number; message: string }> }> {
    if (input.columns.length === 0 || input.rows.length === 0) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Nothing to import' })
    }
    const target = quoteQualified(input.schema, input.table)
    const cols = input.columns.map((c) => this.quoteColumn(c)).join(', ')
    const c = input.columns.length
    const batch = input.batchSize > 0 ? Math.min(input.batchSize, 500) : 200
    let inserted = 0
    let failed = 0
    const errors: Array<{ row: number; message: string }> = []

    const runBatches = async (): Promise<void> => {
      for (let i = 0; i < input.rows.length; i += batch) {
        const slice = input.rows.slice(i, i + batch)
        const values: unknown[] = []
        const tuples: string[] = []
        slice.forEach((row, j) => {
          if (row.length !== c) {
            failed += 1
            errors.push({
              row: i + j + 2, // 1-based incl. header
              message: `expected ${c} values, got ${row.length}`,
            })
            return
          }
          const start = values.length
          values.push(...row)
          tuples.push(`(${row.map((_, k) => `$${start + k + 1}`).join(', ')})`)
        })
        if (tuples.length === 0) continue
        const sql = `INSERT INTO ${target} (${cols}) VALUES ${tuples.join(', ')}`
        try {
          const res = await conn.client.query({ text: sql, values })
          inserted += res.rowCount ?? 0
        } catch (err) {
          // Report the whole batch as failed (rows are not individually recoverable).
          failed += slice.length
          const msg = this.translatePgError(err).message
          errors.push({ row: i + 2, message: msg })
        }
      }
    }

    if (input.transactional) {
      try {
        await conn.client.query('BEGIN')
        await runBatches()
        await conn.client.query('COMMIT')
      } catch (err) {
        await conn.client.query('ROLLBACK').catch(() => undefined)
        throw this.translatePgError(err)
      }
    } else {
      await runBatches()
    }
    return { inserted, failed, errors }
  }

  async *exportRows(
    conn: PgConn,
    input: { sql: string; params?: readonly unknown[]; maxRows: number },
  ): AsyncIterable<Record<string, unknown>> {
    const sql = `${input.sql.trim().replace(/;+\s*$/, '')}`
    const res = await conn.client.query({
      text: sql,
      values: input.params && input.params.length ? [...input.params] : [],
      rowMode: 'array',
    })
    const fields = res.fields
    let sent = 0
    for (const row of res.rows as Array<Array<unknown>>) {
      if (sent >= input.maxRows) break
      const obj: Record<string, unknown> = {}
      fields.forEach((f, i) => {
        obj[f.name] = row[i]
      })
      yield obj
      sent += 1
    }
  }

  async listRoles(conn: PgConn): Promise<RoleInfo[]> {
    const rows = (await conn.client.query(String.raw`
      SELECT r.rolname,
             ARRAY(SELECT rm.rolname
                   FROM pg_catalog.pg_auth_members m
                   JOIN pg_catalog.pg_roles rm ON rm.oid = m.roleid
                   WHERE m.member = r.oid) AS member_of,
             ARRAY[
               r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
               r.rolcanlogin, r.rolreplication, r.rolbypassrls
             ] AS flags
      FROM pg_catalog.pg_roles r
      ORDER BY r.rolname
    `)).rows as Array<{ rolname: string; member_of: string[]; flags: boolean[] }>

    const flagNames = [
      'SUPERUSER',
      'CREATEDB',
      'CREATEROLE',
      'INHERIT',
      'LOGIN',
      'REPLICATION',
      'BYPASSRLS',
    ]
    return rows.map((r) => ({
      name: r.rolname,
      attributes: r.flags.map((f, i) => (f ? flagNames[i]! : '')).filter(Boolean),
      memberOf: r.member_of,
    }))
  }

  async listGrants(conn: PgConn, schema?: string): Promise<GrantInfo[]> {
    // information_schema.role_table_grants is role-dependent and never raises
    // privileges the connected role does not have.
    let schemaClause = ''
    const params: string[] = []
    if (schema) {
      params.push(schema)
      schemaClause = ' AND table_schema = $1'
    }
    const rows = (await conn.client
      .query(
        String.raw`
          SELECT grantee AS role, table_schema AS schema, table_name AS object_name,
                 table_type AS object_type, privilege_type AS privilege, is_grantable AS grantable
          FROM information_schema.role_table_grants
          WHERE 1=1${schemaClause}
        `,
        params,
      )
      .catch(() => ({ rows: [] as Array<Record<string, unknown>> }))).rows as Array<{
      role: string
      schema: string
      object_name: string
      object_type: string
      privilege: string
      grantable: string
    }>
    return rows.map((r) => ({
      role: r.role,
      schema: r.schema,
      objectType: r.object_type,
      objectName: r.object_name,
      privilege: r.privilege,
      grantable: r.grantable === 'YES',
    }))
  }

  async getStats(conn: PgConn): Promise<DatabaseStats> {
    const client = conn.client

    const size = await client
      .query('SELECT pg_database_size(current_database()) AS bytes')
      .catch(() => ({ rows: [{ bytes: null }] }))
    const counts = await client
      .query(String.raw`
        SELECT
          (SELECT COUNT(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')) AS tables,
          (SELECT COUNT(*) FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema') AS schemas,
          (SELECT COUNT(*) FROM pg_catalog.pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema')) AS indexes,
          (SELECT COUNT(*) FROM pg_catalog.pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema')) AS views
      `)
      .catch(() => ({ rows: [{ tables: 0, schemas: 0, indexes: 0, views: 0 }] })) as {
      rows: Array<{ tables: number; schemas: number; indexes: number; views: number }>
    }
    const conns = await client
      .query(String.raw`
        SELECT pid, usename::text AS "user", datname::text AS database, state, query,
               EXTRACT(EPOCH FROM (now() - query_start))::int * 1000 AS duration_ms
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
      `)
      .catch(() => ({ rows: [] })) as { rows: Array<Record<string, unknown>> }
    const hit = await client
      .query(String.raw`SELECT blks_hit::bigint, blks_read::bigint FROM pg_stat_database WHERE datname = current_database()`)
      .catch(() => ({ rows: [] })) as { rows: Array<{ blks_hit: number; blks_read: number }> }
    const version = await client.query('SHOW server_version').catch(() => ({ rows: [{ server_version: null }] }))

    const r0 = counts.rows[0] ?? { tables: 0, schemas: 0, indexes: 0, views: 0 }
    const hitRatio =
      hit.rows[0] && hit.rows[0].blks_hit + (hit.rows[0].blks_read ?? 0) > 0
        ? hit.rows[0].blks_hit / (hit.rows[0].blks_hit + hit.rows[0].blks_read)
        : null

    return {
      sizeBytes: size.rows[0]?.bytes ?? null,
      tableCount: r0.tables,
      schemaCount: r0.schemas,
      indexCount: r0.indexes,
      viewCount: r0.views,
      connectionCount: conns.rows.length,
      cacheHitRatio: hitRatio,
      activeConnections: conns.rows.map((r) => ({
        pid: Number(r.pid),
        user: String(r.user ?? ''),
        database: String(r.database ?? ''),
        state: r.state ? String(r.state) : null,
        query: r.query ? String(r.query) : null,
        durationMs: Number(r.duration_ms ?? 0),
      })),
      version: version.rows[0]?.server_version ? String(version.rows[0].server_version) : null,
    }
  }

  // ---------------------------------------------------------------------
  // private loaders
  // ---------------------------------------------------------------------

  private async loadColumns(client: pg.Client, schema: string, table: string): Promise<TableColumnInfo[]> {
    const rows = (await client.query(
      String.raw`
        SELECT a.attname AS name,
               format_type(a.atttypid, a.atttypmod) AS data_type,
               NOT a.attnotnull AS nullable,
               pg_get_expr(d.adbin, d.adrelid) AS default_value,
               a.attnum AS ordinal_position,
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_index i
                 WHERE i.indrelid = a.attrelid AND i.indisprimary
                   AND a.attnum = ANY (i.indkey)
               ) AS is_primary_key,
               a.attlen AS max_length,
               CASE WHEN nd.nspname = 'pg_catalog' AND t.typtype = 'e'
                 THEN (SELECT ARRAY(SELECT enumlabel FROM pg_catalog.pg_enum
                                    WHERE enumtypid = a.atttypid ORDER BY enumsortorder))
                 ELSE NULL END AS enum_values
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_catalog.pg_namespace nd ON nd.oid = t.typnamespace
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `,
      [schema, table],
    )).rows as Array<Record<string, unknown>>

    return rows.map((r) => ({
      name: String(r.name),
      dataType: String(r.data_type),
      nullable: Boolean(r.nullable),
      defaultValue: r.default_value == null ? null : String(r.default_value),
      ordinalPosition: Number(r.ordinal_position),
      isPrimaryKey: Boolean(r.is_primary_key),
      maxLength: r.max_length == null ? null : Number(r.max_length),
      numericPrecision: null,
      numericScale: null,
      comment: null,
      enumValues: Array.isArray(r.enum_values) ? (r.enum_values as string[]) : null,
    }))
  }

  private async loadForeignKeys(client: pg.Client, schema: string, table: string): Promise<TableForeignKey[]> {
    const rows = (await client.query(
      String.raw`
        SELECT con.conname AS name,
               a.attname AS column,
               refn.nspname AS referenced_schema,
               refc.relname AS referenced_table,
               refa.attname AS referenced_column
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
        JOIN pg_catalog.pg_class refc ON refc.oid = con.confrelid
        JOIN pg_catalog.pg_namespace refn ON refn.oid = refc.relnamespace
        JOIN pg_catalog.pg_attribute refa ON refa.attrelid = refc.oid AND refa.attnum = con.confkey[1]
        WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
        ORDER BY con.conname
      `,
      [schema, table],
    )).rows as Array<Record<string, unknown>>
    return rows.map((r) => ({
      name: String(r.name),
      column: String(r.column),
      referencedSchema: String(r.referenced_schema),
      referencedTable: String(r.referenced_table),
      referencedColumn: String(r.referenced_column),
    }))
  }

  private async loadUniqueConstraints(client: pg.Client, schema: string, table: string) {
    const rows = (await client.query(
      String.raw`
        SELECT con.conname AS name,
               ARRAY(SELECT a.attname FROM pg_catalog.unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                     JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS columns
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype IN ('u','p') AND n.nspname = $1 AND c.relname = $2
        ORDER BY con.conname
      `,
      [schema, table],
    )).rows as Array<{ name: string; columns: string[] }>
    return rows
  }

  private async loadIndexes(client: pg.Client, schema: string, table: string): Promise<TableIndex[]> {
    const rows = (await client.query(
      String.raw`
        SELECT idx.oid::regclass::text AS name,
               ix.indisunique AS unique,
               ix.indisprimary AS primary,
               ARRAY(SELECT a.attname FROM pg_catalog.unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                     LEFT JOIN pg_catalog.pg_attribute a
                       ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                     WHERE a.attnum > 0 ORDER BY k.ord) AS columns
        FROM pg_catalog.pg_index ix
        JOIN pg_catalog.pg_class idx ON idx.oid = ix.indexrelid
        JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND NOT ix.indisprimary
        ORDER BY idx.relname
      `,
      [schema, table],
    )).rows as Array<{ name: string; unique: boolean; primary: boolean; columns: string[] }>
    return rows.slice(0, 100).map((r) => ({
      name: r.name,
      columns: r.columns,
      unique: Boolean(r.unique),
      primary: Boolean(r.primary),
    }))
  }

  // ---- error translation --------------------------------------------

  translatePgError(err: unknown): AppError {
    const e = err as { code?: string; message?: string; routine?: string; severity?: string }
    const message = e.message ? String(e.message) : 'PostgreSQL error'

    switch (e.code) {
      case '28P01':
        return new AppError({
          code: 'UNAUTHORIZED',
          message: 'Authentication failed: invalid role or password',
          detail: message,
        })
      case '3D000':
        return new AppError({
          code: 'NOT_FOUND',
          message: `Database does not exist`,
          detail: message,
        })
      case '42P01':
        return new AppError({
          code: 'QUERY_ERROR',
          message: 'Relation does not exist',
          detail: message,
        })
      case '42501':
        return new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Permission denied: the connected role may not view or modify this object',
          detail: message,
        })
      case '23505':
        return new AppError({
          code: 'CONFLICT',
          message: 'Unique constraint violation: a conflicting row already exists',
          detail: message,
        })
      case '23503':
        return new AppError({
          code: 'CONFLICT',
          message: 'Foreign key violation: the referenced row does not exist',
          detail: message,
        })
      case '2BP01':
        return new AppError({
          code: 'CONFLICT',
          message: 'Cannot drop this object because other objects depend on it',
          detail: message,
        })
      case '42P07':
        return new AppError({
          code: 'CONFLICT',
          message: 'An object with that name already exists',
          detail: message,
        })
      case '42703':
      case '42704':
        return new AppError({
          code: 'QUERY_ERROR',
          message: 'Unknown column or object: ' + safePgMessage(message),
          detail: message,
        })
      case '42601':
        return new AppError({
          code: 'QUERY_ERROR',
          message: 'SQL syntax error: ' + safePgMessage(message),
          detail: message,
        })
      case '0A000':
        return new AppError({
          code: 'QUERY_ERROR',
          message: 'Feature not supported by this PostgreSQL server: ' + safePgMessage(message),
          detail: message,
        })
      case '25006':
        return new AppError({
          code: 'QUERY_ERROR',
          message: 'Statement rejected: the transaction is read-only',
          detail: message,
        })
      case '23502':
        return new AppError({
          code: 'BAD_REQUEST',
          message: 'A required column cannot be null',
          detail: message,
        })
      case '23514':
        return new AppError({
          code: 'BAD_REQUEST',
          message: 'A check constraint rejected the value',
          detail: message,
        })
      case '40001':
        return new AppError({
          code: 'CONFLICT',
          message: 'Concurrent update conflict: retry the operation',
          detail: message,
        })
      case '53300':
        return new AppError({
          code: 'CONNECTION_FAILED',
          message: 'The database refused the connection: too many clients',
          detail: message,
        })
      case '22P02':
      case '22007':
        return new AppError({
          code: 'BAD_REQUEST',
          message: 'Invalid data type for the supplied value',
          detail: message,
        })
      case '57014':
        return new AppError({
          code: 'QUERY_CANCELLED',
          message: 'Query was cancelled or timed out',
          detail: message,
        })
      case '08001':
      case '08004':
      case '08006':
        return new AppError({
          code: 'CONNECTION_FAILED',
          message: 'Could not connect to the database',
          detail: message,
        })
      case 'ECONNREFUSED':
        return new AppError({
          code: 'CONNECTION_FAILED',
          message: 'Connection refused by the database host',
          detail: message,
        })
      case 'ETIMEDOUT':
        return new AppError({
          code: 'CONNECTION_FAILED',
          message: 'Connection to the database host timed out',
          detail: message,
        })
      default: {
        if (/rejectUnauthorized|self.signed|unable to verify|SELF_SIGNED|CERT/.test(message) || e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
          return new AppError({
            code: 'TLS_ERROR',
            message: 'TLS certificate verification failed for the database host',
            detail: message,
          })
        }
        if (/timed out|timeout/i.test(message)) {
          return new AppError({
            code: 'QUERY_TIMEOUT',
            message: 'Database operation timed out',
            detail: message,
          })
        }
        // SQL/DDL-class errors carry a message that is meaningful to the
        // operator (missing relation, bad cast, unsupported command). It is
        // redacted so a value pasted into the statement cannot leak.
        if (/^(?:42|23|2B|0A|25|40|53|54|55)/.test(String(e.code ?? ''))) {
          return new AppError({
            code: 'QUERY_ERROR',
            message: 'Database rejected the statement: ' + safePgMessage(message),
            detail: message,
          })
        }
        return new AppError({
          code: 'QUERY_ERROR',
          message: 'Database query failed',
          detail: message,
        })
      }
    }
  }

  private isReadOnlyStatement(sql: string): boolean {
    const first = sql.trimStart().replace(/\/\*[\s\S]*?\*\//g, '').trimStart().split(/\s+/)[0]?.toUpperCase()
    return first === 'SELECT' || first === 'WITH' || first === 'SHOW' || first === 'EXPLAIN' || first === 'VALUES' || first === 'TABLE'
  }
}

function normalizeKind(kind: string): TableInfo['kind'] {
  switch (kind) {
    case 'r':
    case 'p':
      return kind === 'p' ? 'partitioned_table' : 'table'
    case 'v':
      return 'view'
    case 'm':
      return 'materialized_view'
    case 'f':
      return 'foreign_table'
    default:
      return 'table'
  }
}

const TABLE_OBJECTS_SQL = String.raw`
  SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f')
    AND n.nspname NOT LIKE 'pg\_%'
    AND n.nspname <> 'information_schema'
  ORDER BY n.nspname, c.relname
`

export type PostgresClient = pg.Client

/** Build a pg Client that is TLS-verified and pinned to the validated address. */
export function buildPgClient(opts: {
  host: string
  port: number
  database: string
  role: string
  password: string
  pinnedAddress: string
  connectionTimeoutMs?: number
  applicationName?: string
  statementTimeoutMs?: number
}): pg.Client {
  return new Client({
    host: opts.host,
    port: opts.port,
    database: opts.database,
    user: opts.role,
    password: opts.password,
    application_name: opts.applicationName ?? 'db-horizon',
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 10_000,
    statement_timeout: opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS,
    ssl: {
      rejectUnauthorized: true,
      servername: opts.host, // verify cert hostname against the Neon host
    },
    stream: () => createPinnedSocket(opts.pinnedAddress),
  })
}

/**
 * Reduce a PostgreSQL error message to a single, redacted line safe to show in
 * the browser. Server-side paths keep the full detail for logs.
 */
function safePgMessage(message: string): string {
  const firstLine = message.split('\n')[0] ?? ''
  const redacted = redact(firstLine, { secrets: [] })
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted
}
