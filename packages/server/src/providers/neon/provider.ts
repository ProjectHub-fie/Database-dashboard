import pg from 'pg'
import crypto from 'node:crypto'
import {
  Capability,
  ConnectionMetadata,
  ConnectionRef,
  Provider,
  ProviderCapabilities,
  QuerySession,
  DatabaseAdapter,
  ControlPlaneAdapter,
} from '../types.js'
import { PostgresAdapter, PgConn, buildPgClient } from '../../adapters/postgres.js'
import { PgQuerySession } from '../../adapters/query-session.js'
import {
  NeonControlPlane,
  NeonHttpClient,
} from './client.js'
import { verifyNeonConnectionUrl, verifyNeonHost } from '../../security/netlib.js'
import { readOnlyRoles } from '../../security/roles.js'

const { Client } = pg

const NEON_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'sql.basic',
  'sql.transactions',
  'sql.cancel',
  'sql.statementTimeout',
  'schema.discover',
  'schema.createTable',
  'schema.alterTable',
  'schema.createIndex',
  'schema.createView',
  'schema.createSchema',
  'schema.manageRoles',
  'browse.tables',
  'browse.insert',
  'browse.update',
  'browse.delete',
  'data.export.csv',
  'data.export.json',
  'data.export.sql',
  'data.import.csv',
  'data.import.json',
  'control.listProjects',
  'control.createProject',
  'control.listBranches',
  'control.createBranch',
  'control.deleteBranch',
  'control.listDatabases',
  'control.createDatabase',
  'control.deleteDatabase',
  'control.listEndpoints',
  'control.operations',
  'control.deleteProject',
  'monitoring.usage',
  'audit.queryHistory',
])

export interface NeonProviderOptions {
  /**
   * Set true in the app to require a real Neon API key + console fetch.
   * Tests inject `http` and may set this false when validating a fake URL.
   */
  skipConnectionUrlHostValidation?: boolean
  http?: NeonHttpClient
  maxRows?: number
  statementTimeoutMs?: number
  buildCancellationConnection?: (opts: { conn: PgConn; applicationName: string }) => pg.Pool
}

/**
 * Neon provider: PostgreSQL-compatible engine adapter + Neon control plane.
 * The two auth modes map onto two capabilities: 'connection' (database URL)
 * and 'api' (Neon API key). Connection mode never touches the control plane.
 */
export class NeonProvider implements Provider<PgConn> {
  readonly info = {
    id: 'neon',
    name: 'Neon PostgreSQL',
    kind: 'postgres' as const,
    controlPlane: true,
    apiBaseUrl: 'https://console.neon.tech/api/v2',
    apiDocs: 'https://neon.com/docs/reference/api',
  }

  readonly database: DatabaseAdapter<PgConn>

  private readonly opts: NeonProviderOptions

  constructor(opts: NeonProviderOptions = {}) {
    this.opts = opts
    this.database = new PostgresAdapter({
      maxRows: opts.maxRows,
      statementTimeoutMs: opts.statementTimeoutMs,
    })
  }

  capabilities(): ProviderCapabilities {
    return { auth: ['connection', 'api'], capabilities: NEON_CAPABILITIES }
  }

  /**
   * Control plane is instantiated per API-key connection because it captures
   * the key. With a database URL there is no control plane.
   */
  controlPlaneFor(apiKey: string): ControlPlaneAdapter {
    return new NeonControlPlane(apiKey, this.opts.http)
  }

  registerSecrets(_sink: (secrets: readonly string[]) => void): void {
    // Session manager feeds per-connection secrets; nothing to register globally.
  }

  async connect(
    input:
      | { kind: 'connection'; connectionString: string }
      | { kind: 'api'; apiKey: string },
  ): Promise<{ connection: ConnectionRef<PgConn> | null; metadata: ConnectionMetadata; accountOnly: boolean }> {
    if (input.kind === 'api') {
      const control = this.controlPlaneFor(input.apiKey)
      await control.validateApiKey() // throws on 401
      return {
        connection: null,
        metadata: {
          providerId: 'neon',
          host: 'console.neon.tech',
          database: '',
          role: '',
          readOnly: false,
          region: undefined,
        },
        accountOnly: true,
      }
    }

    // ---- database URL mode ----
    const url = new URL(input.connectionString)
    const raw = await verifyNeonConnectionUrl(input.connectionString, {
      allowLocalhost: this.opts.skipConnectionUrlHostValidation === true && configNodeIsTest(),
    })

    const password = url.password ? decodeURIComponent(url.password) : ''
    const readOnly = readOnlyRoles.has(raw.role.toLowerCase())

    const client = buildPgClient({
      host: raw.host,
      port: raw.port,
      database: raw.database,
      role: raw.role,
      password,
      pinnedAddress: raw.verified.address,
      applicationName: 'db-horizon',
    })

    try {
      await client.connect()
    } catch (err) {
      await client.end().catch(() => undefined)
      throw (this.database as PostgresAdapter).translatePgError(err)
    }
    const conn: PgConn = {
      client,
      role: raw.role,
      database: raw.database,
      pinnedAddress: raw.verified.address,
      clientOptions: {
        host: raw.host,
        port: raw.port,
        database: raw.database,
        user: raw.role,
        password,
        ssl: { rejectUnauthorized: true, servername: raw.host },
        stream: undefined,
        connectionTimeoutMillis: 10_000,
        applicationName: 'db-horizon',
      },
    }
    // Expose the same pinned stream factory used for the main client on the
    // metadata holder so query sessions can reuse it for cancel/keepalive.
    const streamFactory = (client as unknown as {
      connection?: { stream?: unknown }
    }).connection?.stream
    ;(conn.clientOptions as { stream: unknown }).stream = streamFactory

    return {
      connection: {
        id: cryptoRandomId(),
        providerId: 'neon',
        conn,
        metadata: {
          providerId: 'neon',
          host: raw.host,
          database: raw.database,
          role: raw.role,
          readOnly,
          region: raw.host.split('.')[0] ?? undefined,
        },
        refcount: 0,
        lastActiveAt: Date.now(),
      },
      metadata: {
        providerId: 'neon',
        host: raw.host,
        database: raw.database,
        role: raw.role,
        readOnly,
        region: undefined,
      },
      accountOnly: false,
    }
  }

  async disconnect(ref: ConnectionRef<PgConn> | null): Promise<void> {
    if (ref) await this.database.dispose?.(ref.conn)
  }

  createConnectionSession(ref: ConnectionRef<PgConn>): QuerySession {
    const session = new PgQuerySession(ref.conn, this.database as PostgresAdapter, {
      maxRows: this.opts.maxRows,
      statementTimeoutMs: this.opts.statementTimeoutMs,
      buildCancellationConnection: this.opts.buildCancellationConnection,
    })
    return session
  }
}

function cryptoRandomId(): string {
  return crypto.randomBytes(12).toString('hex')
}

function configNodeIsTest(): boolean {
  return process.env.NODE_ENV === 'test'
}

/** Re-export for the connection-mode CSR: verify + pin a Neon host for the UI. */
export { verifyNeonHost }
export type NeonPgConnection = PgConn
export { Client }