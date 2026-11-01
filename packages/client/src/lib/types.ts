// Shared types mirroring the server contract (packages/server/src/providers/types.ts
// and the API routes). Never place credentials or connection strings here.

export type AuthMethod = 'connection' | 'api'

export interface Capabilities {
  auth: readonly AuthMethod[]
  capabilities: readonly string[]
}

export interface ConnectionMetadata {
  providerId: string
  host: string
  database: string
  role: string
  region?: string
  readOnly: boolean
  /** Optional operator label. Never a credential. */
  displayName?: string
  /** Control-plane coordinates, set when a database was picked in API mode. */
  projectId?: string
  projectName?: string
  branchId?: string
  branchName?: string
}

/**
 * One entry from GET /api/providers. `available: false` entries are roadmap
 * items: they must never be selectable as a working connection mode.
 */
export interface ProviderCatalogEntry {
  id: string
  name: string
  kind: 'postgres' | 'mysql' | 'mariadb'
  available: boolean
  authMethods: string[]
  controlPlane: boolean
  apiDocs?: string
  capabilities: string[]
  blockedBy?: string
}

export interface ConnectionStatus {
  connected: boolean
  auth?: AuthMethod
  providerId?: string
  metadata?: ConnectionMetadata
  accountOnly?: boolean
  capabilities?: Capabilities
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
  platformId?: string
  createdAt?: string
  updatedAt?: string
}

export interface Branch {
  id: string
  name: string
  projectId: string
  createdAt?: string
  updatedAt?: string
  primary: boolean
}

export interface Database {
  id?: string
  name: string
  projectId: string
  branchId: string
  owner?: string
  createdAt?: string
}

export interface DatabaseRole {
  name: string
  branchId: string
  protected?: boolean
  authenticationMethod?: string
  createdAt?: string
}

export interface Endpoint {
  id: string
  branchId: string
  host: string | null
  region?: string
  state: string
  type?: string
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
}

export interface SchemaObjectSummary {
  schema: string
  name: string
  kind: 'table' | 'view' | 'materialized_view' | 'foreign_table' | 'partitioned_table'
}

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

export interface QueryHistoryEntry {
  id: string
  sql: string
  durationMs: number
  rowCount: number | null
  error: string | null
  createdAt: number
}

export interface SavedQuery {
  id: string
  name: string
  sql: string
}

export interface ApiErrorBody {
  error: { code: string; message: string }
  requestId?: string
}

export const ERROR_CODES = {
  rateLimited: 'RATE_LIMITED',
  providerRateLimited: 'PROVIDER_RATE_LIMITED',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  needsReauth: 'NEEDS_REAUTH',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  badRequest: 'BAD_REQUEST',
  connectionFailed: 'CONNECTION_FAILED',
  connectionUnsupportedHost: 'CONNECTION_UNSUPPORTED_HOST',
  providerError: 'PROVIDER_ERROR',
  queryError: 'QUERY_ERROR',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
} as const