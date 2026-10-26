/**
 * Multi-provider contract for DB Remote.
 *
 * Each provider is composed of (at most) two adapters:
 *   - a *database engine* adapter (PostgreSQL, MySQL, ...) that executes SQL
 *     and discovers schema over a live connection, and
 *   - a *control-plane* adapter (Neon API, Supabase API, ...) that manages
 *     cloud resources.
 *
 * Providers declare capabilities; the UI derives what to show from them.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type AuthMethod = 'connection' | 'api'

export type Capability =
  | 'sql.basic' // execute read/write DQL and DML
  | 'sql.transactions'
  | 'sql.cancel'
  | 'sql.statementTimeout'
  | 'schema.discover'
  | 'schema.createTable'
  | 'schema.alterTable'
  | 'schema.createIndex'
  | 'schema.createView'
  | 'schema.createSchema'
  | 'schema.manageRoles'
  | 'browse.tables'
  | 'browse.insert'
  | 'browse.update'
  | 'browse.delete'
  | 'data.export.csv'
  | 'data.export.json'
  | 'data.export.sql'
  | 'data.import.csv'
  | 'data.import.json'
  | 'control.listProjects'
  | 'control.createProject'
  | 'control.listBranches'
  | 'control.createBranch'
  | 'control.deleteBranch'
  | 'control.listDatabases'
  | 'control.createDatabase'
  | 'control.deleteDatabase'
  | 'control.listEndpoints'
  | 'control.operations'
  | 'control.deleteProject'
  | 'monitoring.usage'
  | 'monitoring.connections'
  | 'audit.queryHistory'

export interface ProviderCapabilities {
  auth: ReadonlyArray<AuthMethod>
  capabilities: ReadonlySet<Capability>
}

// ---------------------------------------------------------------------------
// Normalized resources
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  id: string
  name: string
  /** Database engine family. Only `postgres` is implemented in this release. */
  kind: 'postgres' | 'mysql' | 'mariadb'
  controlPlane: boolean
  apiBaseUrl?: string
  apiDocs: string
}

/**
 * Engine dialect descriptor.
 *
 * The shared API layer never builds SQL text, so every dialect difference has to
 * be declared by the engine adapter rather than assumed. This is what keeps
 * PostgreSQL syntax (`$1` placeholders, double-quoted identifiers, a separate
 * schema namespace) from leaking into an engine with different rules — MySQL
 * uses `?` placeholders, backticks, and its database *is* the schema layer.
 */
export interface EngineDialect {
  kind: 'postgres' | 'mysql' | 'mariadb'
  /** Placeholder text for the Nth positional parameter (1-based). */
  placeholder: (position: number) => string
  /** Quote a single identifier using the engine's own rules. */
  quoteIdentifier: (name: string) => string
  defaultPort: number
  /** `namespace` = schemas inside one database; `database` = database is the schema. */
  schemaModel: 'namespace' | 'database'
}

export interface ConnectionMetadata {
  providerId: string
  /** Safe display host, e.g. `ep-bright-xyz-123.us-east-2.aws.neon.tech`. */
  host: string
  /** Database name. */
  database: string
  /** Role actually used for the connection. */
  role: string
  /** Display-only region or region host. */
  region?: string
  /** Read-only value is derived from the connected role, never from a UI toggle. */
  readOnly: boolean
  /** Control-plane coordinates, present when the connection came from API mode. */
  projectId?: string
  projectName?: string
  branchId?: string
  branchName?: string
}

export interface Organization {
  id: string
  name: string
}

export interface Project {
  id: string
  name: string
  orgId?: string
  region?: string
  /** PlatformId for Neon API v2 (`{orgId}/{projectId}`). */
  platformId?: string
  createdAt?: string
  updatedAt?: string
  raw?: unknown
}

export interface Branch {
  id: string
  name: string
  projectId: string
  createdAt?: string
  updatedAt?: string
  primary: boolean
  raw?: unknown
}

export interface Database {
  id?: string
  name: string
  projectId: string
  branchId: string
  owner?: string
  createdAt?: string
  raw?: unknown
}

export interface Endpoint {
  id: string
  branchId: string
  host: string | null
  region?: string
  state: string
  type?: string
  raw?: unknown
}

export interface ProviderOperation {
  id: string
  action: string
  status: 'running' | 'finished' | 'failed' | 'error' | 'canceling' | 'canceled' | 'scheduled'
  sourceIp?: string
  projectId?: string
  branchId?: string
  createdAt?: string
  updatedAt?: string
  finishedAt?: string
  error?: string
  raw?: unknown
}

/** Neon usage/account details normalized key used only when the provider returns them. */
export interface UsageMetric {
  metric: 'wcu' | 'written_data' | 'synthetic_storage_size' | 'data_transfer'
  source: 'autoscaling' | 'fixed_size' | 'endpoint' | 'account' | 'project'
  interval?: string
  value: number
  unit?: string
}

export interface ProjectConnectionInfo {
  /** A safe display name for the connection (no credentials). */
  displayName: string
  host: string
  port: number
  database: string
  role: string
  poolerEnabled?: boolean
  poolerHost?: string
}

// ---------------------------------------------------------------------------
// Database engine adapter
// ---------------------------------------------------------------------------

export interface TableColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
  ordinalPosition: number
  isPrimaryKey: boolean
  isUniqueKey?: boolean
  maxLength?: number | null
  numericPrecision?: number | null
  numericScale?: number | null
  comment?: string | null
  enumValues?: string[] | null
}

export interface TableForeignKey {
  name: string
  column: string
  referencedSchema: string
  referencedTable: string
  referencedColumn: string
}

export interface TableIndex {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  definition?: string
}

export interface TableInfo {
  schema: string
  name: string
  kind: 'table' | 'view' | 'materialized_view' | 'foreign_table' | 'partitioned_table'
  owner?: string
  columns: TableColumnInfo[]
  primaryKeyColumns: string[]
  foreignKeys: TableForeignKey[]
  uniqueConstraints: Array<{ name: string; columns: string[] }>
  indexes: TableIndex[]
  rowEstimate?: number | null
}

export interface SchemaObjectSummary {
  schema: string
  name: string
  kind: 'table' | 'view' | 'materialized_view' | 'foreign_table' | 'partitioned_table'
}

export interface RowPage {
  columns: string[]
  rows: Array<Record<string, unknown>>
  total: number | null
  truncated: boolean
  offset: number
}

export interface QueryResult {
  statement: string
  columns: Array<{ name: string; typeOid?: number; typeName?: string }>
  rows: Array<Record<string, unknown>>
  rowCount: number | null
  truncated: boolean
  durationMs: number
  readOnly: boolean
}

export interface SchemaTree {
  schemas: Array<{
    name: string
    owner: string | null
    objects: SchemaObjectSummary[]
  }>
}

export interface TableStats {
  rowEstimate: number | null
  totalSizeBytes: number | null
}

export interface RoleInfo {
  name: string
  attributes: string[]
  memberOf: string[]
}

export interface GrantInfo {
  role: string
  schema: string | null
  objectType: string | null
  objectName: string | null
  privilege: string
  grantable: boolean
}

export interface DatabaseStats {
  sizeBytes: number | null
  tableCount: number
  schemaCount: number
  indexCount: number
  viewCount: number
  connectionCount: number
  cacheHitRatio: number | null
  activeConnections: Array<{
    pid: number
    user: string
    database: string
    state: string | null
    query: string | null
    durationMs: number
  }>
  version: string | null
}

export interface SqlExecutionOptions {
  /** Backend-enforced row limit. */
  maxRows?: number
  statementTimeoutMs?: number
  /** Cancel a running query by its client-side run id. */
  onCancelRequested?: (runId: string) => void
}

export interface DatabaseAdapter<Conn = unknown> {
  readonly kind: 'postgres' | string
  /**
   * Declared engine dialect. Required so a MySQL/MariaDB adapter can plug in
   * without the shared layer assuming PostgreSQL placeholder/quoting rules.
   */
  readonly dialect: EngineDialect
  /**
   * Execute a single statement with fully parameterized values and safely
   * quoted identifiers resolved by the caller. Options may be applied server
   * side (e.g. per-statement `statement_timeout`); the caller must never be
   * able to inject SQL via options.
   */
  executeStatement(
    conn: Conn,
    input: { sql: string; params?: readonly unknown[] },
    opts?: SqlExecutionOptions,
  ): Promise<QueryResult>

  cancelStatement(conn: Conn, runId: string): Promise<void>

  getSchemaTree(conn: Conn): Promise<SchemaTree>

  getTableInfo(conn: Conn, input: { schema: string; table: string }): Promise<TableInfo>

  listTableObjects(conn: Conn): Promise<SchemaObjectSummary[]>

  getStats(conn: Conn): Promise<DatabaseStats>

  /**
   * Resolve an identifier to a canonical, quoted SQL identifier. `name` may be
   * a table, column, etc. Returns the quoted identifier or throws on invalid
   * characters. Callers must always quote via this method.
   */
  quoteIdentifier(schema: string, name: string): string
  quoteColumn(name: string): string

  /**
   * Insert a row with values parameterized. `quoting` maps column names to
   * ok-to-use quotes so the caller builds the statement from trusted names.
   */
  insertRow(
    conn: Conn,
    input: {
      schema: string
      table: string
      row: Record<string, unknown>
      maxRows?: number
    },
  ): Promise<QueryResult>

  /** Update rows matching the primary key / unambiguous identity. */
  updateRow(
    conn: Conn,
    input: {
      schema: string
      table: string
      identity: Record<string, unknown>
      identityColumns: string[]
      changes: Record<string, unknown>
    },
  ): Promise<QueryResult>

  /** Delete rows matching the primary key / unambiguous identity. */
  deleteRow(
    conn: Conn,
    input: {
      schema: string
      table: string
      identity: Record<string, unknown>
      identityColumns: string[]
    },
  ): Promise<QueryResult>

  /** Roles and grants introspection (permission-aware). */
  listRoles(conn: Conn): Promise<RoleInfo[]>
  listGrants(conn: Conn, schema?: string): Promise<GrantInfo[]>

  /** Isolation-level transaction support where supported. */
  beginTransaction?(conn: Conn, opts?: { readOnly?: boolean; isolation: 'read committed' | 'repeatable read' }): Promise<void>
  commitTransaction?(conn: Conn): Promise<void>
  rollbackTransaction?(conn: Conn): Promise<void>

  importRows?(
    conn: Conn,
    input: {
      schema: string
      table: string
      columns: string[]
      rows: Array<Array<unknown>>
      batchSize: number
      transactional: boolean
    },
  ): Promise<{ inserted: number; failed: number; errors: Array<{ row: number; message: string }> }>

  exportRows?(
    conn: Conn,
    input: { sql: string; params?: readonly unknown[]; maxRows: number },
  ): AsyncIterable<Record<string, unknown>>

  ping(conn: Conn): Promise<{ latencyMs: number; version: string }>

  dispose?(conn: Conn): Promise<void>
}

// ---------------------------------------------------------------------------
// Query execution abstraction (session bound)
// ---------------------------------------------------------------------------

export interface QuerySession {
  /** Run a parameterized statement, honoring limits. */
  execute(input: { sql: string; params?: readonly unknown[] }, opts?: SqlExecutionOptions): Promise<QueryResult>
  cancel(runId: string): Promise<void>
  beginTransaction(opts?: { readOnly?: boolean; isolation?: 'read committed' | 'repeatable read' }): Promise<void>
  commitTransaction(): Promise<void>
  rollbackTransaction(): Promise<void>
  close(): Promise<void>
  readonly readOnly: boolean

  // Convenience passthroughs binding this session's limits to the adapter.
  getSchemaTree(): Promise<SchemaTree>
  listTableObjects(): Promise<SchemaObjectSummary[]>
  getTableInfo(input: { schema: string; table: string }): Promise<TableInfo>
  browseRows(
    schema: string,
    table: string,
    opts: { offset: number; limit: number; orderBy?: string; orderDir?: string; search?: string },
  ): Promise<RowPage>
  /**
   * Every matching row of a table, for a file export. The row cap is decided by
   * the server, never by the caller's query string.
   */
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
  }>
  insertRow(input: { schema: string; table: string; row: Record<string, unknown>; maxRows?: number }): Promise<QueryResult>
  updateRow(input: {
    schema: string
    table: string
    identity: Record<string, unknown>
    identityColumns: string[]
    changes: Record<string, unknown>
  }): Promise<QueryResult>
  deleteRow(input: {
    schema: string
    table: string
    identity: Record<string, unknown>
    identityColumns: string[]
  }): Promise<QueryResult>
  getStats(): Promise<DatabaseStats>
  listRoles(): Promise<RoleInfo[]>
  listGrants(schema?: string): Promise<GrantInfo[]>
  importRows(input: {
    schema: string
    table: string
    columns: string[]
    rows: Array<Array<unknown>>
    batchSize: number
    transactional: boolean
  }): Promise<{ inserted: number; failed: number; errors: Array<{ row: number; message: string }> }>
}

// ---------------------------------------------------------------------------
// Control plane adapter
// ---------------------------------------------------------------------------

export interface ControlPlaneAdapter {
  readonly providerId: string
  readonly apiBaseUrl: string

  /**
   * `organizationScoped` is set when the key cannot read `/users/me` — Neon
   * refuses that for organization API keys — so callers know the identity is
   * absent by design rather than missing.
   */
  validateApiKey(): Promise<{
    organizations?: Organization[]
    accountId?: string
    organizationScoped?: boolean
  }>

  listOrganizations(): Promise<Organization[]>
  listProjects(orgId?: string): Promise<Project[]>
  getProject(input: { projectId: string }): Promise<Project>
  createProject(input: { name: string; orgId?: string; region?: string }): Promise<{ project: Project; operation: ProviderOperation }>
  deleteProject(input: { projectId: string }): Promise<{ operation: ProviderOperation }>

  listBranches(input: { projectId: string }): Promise<Branch[]>
  createBranch(input: { projectId: string; name?: string; parentId?: string }): Promise<{ branch: Branch; operation: ProviderOperation }>
  deleteBranch(input: { projectId: string; branchId: string }): Promise<{ operation: ProviderOperation }>

  listDatabases(input: { projectId: string; branchId: string }): Promise<Database[]>
  createDatabase(input: { projectId: string; branchId: string; name: string; owner?: string }): Promise<{ database: Database; operation?: ProviderOperation }>
  deleteDatabase(input: { projectId: string; branchId: string; databaseName: string }): Promise<{ operation?: ProviderOperation }>

  listEndpoints(input: { projectId: string }): Promise<Endpoint[]>
  getConnectionInfo(input: { projectId: string; databaseName: string; branchId?: string; role?: string }): Promise<ProjectConnectionInfo>

  /**
   * Raw connection URI *including credentials*, for opening a database session
   * from a control-plane credential. Server-side only: callers must never put
   * this value in a response, and must add its password to redaction hints.
   */
  getConnectionUri?(input: {
    projectId: string
    databaseName: string
    branchId?: string
    role?: string
    pooled?: boolean
  }): Promise<string>

  getOperation(input: { operationId: string; projectId?: string }): Promise<ProviderOperation>
  listOperations(input: { projectId?: string; limit?: number }): Promise<ProviderOperation[]>

  /** Availability flags (usage/time travel are feature-gated on the dashboard). */
  supportsUsage?(): boolean
  getUsage?(input: { projectId?: string; from: string; to: string }): Promise<UsageMetric[]>
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

export interface ConnectionCredential {
  /** Parsed, validated connection URL without credentials (for metadata). */
  safeUrl?: string
  urlSecretHints?: string[]
}

export interface Provider<Conn = unknown> {
  readonly info: ProviderInfo
  readonly capabilities: () => ProviderCapabilities

  // ---- lifecycle ------------------------------------------------------
  connect(input: { kind: 'connection'; connectionString: string } | { kind: 'api'; apiKey: string }): Promise<{
    connection: ConnectionRef<Conn> | null
    metadata: ConnectionMetadata
    accountOnly: boolean
  }>

  disconnect(ref: ConnectionRef<Conn> | null): Promise<void>

  createConnectionSession(ref: ConnectionRef<Conn>): QuerySession

  // ---- adapters ---------------------------------------------------------
  readonly database?: DatabaseAdapter<Conn>
  readonly controlPlane?: ControlPlaneAdapter

  /** Register in-memory secret hints this provider holds (for redaction). */
  registerSecrets(sink: (secrets: readonly string[]) => void): void
}

export interface ConnectionRef<Conn = unknown> {
  readonly id: string
  readonly providerId: string
  readonly conn: Conn
  readonly metadata: ConnectionMetadata
  /** Number of active query sessions borrowing this connection. */
  refcount: number
  /** Timestamp of last activity. */
  lastActiveAt: number
}

export interface ProviderRegistry {
  register(provider: Provider<unknown>): void
  get(id: string): Provider<unknown> | undefined
  list(): Array<Provider<unknown>>
  capabilities(id: string): ProviderCapabilities | undefined
}