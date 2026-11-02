/**
 * MongoDB Atlas provider: document engine adapter + Atlas control plane.
 *
 * Connection mode accepts the `mongodb://` / `mongodb+srv://` connection
 * string Atlas provides (only `*.mongodb.net` hosts are allowed), pins the
 * socket to the verified address and verifies TLS against the original
 * hostname. API mode accepts a service-account `clientId:clientSecret`
 * credential pair (a single field) and manages Atlas projects/clusters.
 *
 * Because the shared `capabilitiesForAuth` treats `control.*` as API-only,
 * and SQL is not part of the document model, this provider declares no
 * `sql.*` capabilities at all — the SQL Studio button never appears for Mongo.
 */

import crypto from 'node:crypto'
import {
  Capability,
  ConnectionMetadata,
  ConnectionRef,
  ControlPlaneAdapter,
  Provider,
  ProviderCapabilities,
  QuerySession,
} from '../types.js'
import { MongodbAdapter, MongoConn } from '../../adapters/mongodb.js'
import { verifyMongodbConnectionUrl } from '../../security/netlib.js'
import { MongoAtlasControlPlane, MongoAtlasControlPlaneOptions } from './client.js'
import { AppError } from '../../lib/errors.js'
import { MongoQuerySession } from '../../adapters/mongo-session.js'

const MONGO_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  // no sql.* — Mongo has no SQL. Document browsing and write path instead.
  'schema.discover',
  'browse.tables',
  'browse.documents',
  'browse.insert',
  'browse.update',
  'browse.delete',
  'data.export.json',
  'data.export.csv',
  'control.listProjects',
  'control.createProject',
  'control.deleteProject',
  'audit.queryHistory', // audit history is provider-independent (dashboard store)
])

export interface MongoProviderOptions {
  /** Tests inject a fake control-plane HTTP + OAuth stack. */
  atlas?: MongoAtlasControlPlaneOptions
  maxRows?: number
  /** Set true in tests to allow `localhost` (a real DNS host in the sandbox). */
  skipConnectionUrlHostValidation?: boolean
}

/**
 * A QuerySession over a Mongo connection. Most shared routes that call SQL are
 * unavailable; this session exposes the document-oriented operations the data
 * browser uses (implemented by the export/import path which maps onto Mongo
 * collection operations).
 */
export class MongoDbProvider implements Provider<MongoConn> {
  readonly info = {
    id: 'mongodb-atlas',
    name: 'MongoDB Atlas',
    kind: 'mongodb' as const,
    controlPlane: true,
    apiBaseUrl: 'https://cloud.mongodb.com/api/atlas/v2',
    apiDocs: 'https://www.mongodb.com/docs/atlas/'
  }

  readonly database: MongodbAdapter

  private readonly opts: MongoProviderOptions

  constructor(opts: MongoProviderOptions = {}) {
    this.opts = opts
    this.database = new MongodbAdapter({ maxRows: opts.maxRows })
  }

  capabilities(): ProviderCapabilities {
    return { auth: ['connection', 'api'], capabilities: MONGO_CAPABILITIES }
  }

  /** Control plane is minted per API-key credential because it captures it. */
  controlPlaneFor(cred: string): ControlPlaneAdapter {
    const { clientId, secret } = splitCredential(cred)
    return new MongoAtlasControlPlane(clientId, secret, this.opts.atlas)
  }

  registerSecrets(_sink: (secrets: readonly string[]) => void): void {
    // Session manager feeds per-connection secrets; nothing global to add.
  }

  async connect(
    input: { kind: 'connection'; connectionString: string } | { kind: 'api'; apiKey: string },
  ): Promise<{ connection: ConnectionRef<MongoConn> | null; metadata: ConnectionMetadata; accountOnly: boolean }> {
    if (input.kind === 'api') {
      const control = this.controlPlaneFor(input.apiKey)
      await control.validateApiKey() // throws on 401
      return {
        connection: null,
        metadata: {
          providerId: 'mongodb-atlas',
          host: 'cloud.mongodb.com',
          database: '',
          role: '',
          readOnly: false,
          region: undefined,
        },
        accountOnly: true,
      }
    }

    // ---- database URL mode ----
    const verified = await verifyMongodbConnectionUrl(input.connectionString, {
      allowLocalhost: this.opts.skipConnectionUrlHostValidation === true && process.env.NODE_ENV === 'test',
    })

    const { parseMongoUri } = await import('../../adapters/mongodb-parse.js')
    const { database, role } = parseMongoUri(input.connectionString)

    const { MongoClient: DriverClient } = await import('mongodb')
    const pinned = verified.verified.address

    /**
     * Custom DNS lookup that always returns the pinned address. The driver
     * still verifies the TLS certificate against the original hostname, so
     * this is the same DNS-rebinding defence as the Postgres path: connect to
     * the pinned IP, but prove identity by hostname.
     */
    const lookup: import('node:net').LookupFunction = (
      _hostname,
      _opts,
      cb,
    ) => {
      cb(null, pinned, 4)
    }

    const client = new DriverClient(input.connectionString, {
      serverSelectionTimeoutMS: 10_000,
      tls: true,
      tlsAllowInvalidCertificates: false,
      lookup,
    })

    try {
      await client.connect()
    } catch (err) {
      await client.close().catch(() => undefined)
      throw translateMongoError(err)
    }

    const conn: MongoConn = {
      client,
      database,
      host: verified.host,
      version: 'unknown',
    }

    return {
      connection: {
        id: crypto.randomBytes(12).toString('hex'),
        providerId: 'mongodb-atlas',
        conn,
        metadata: {
          providerId: 'mongodb-atlas',
          host: verified.host,
          database,
          role,
          readOnly: false,
          region: undefined,
        },
        refcount: 0,
        lastActiveAt: Date.now(),
      },
      metadata: {
        providerId: 'mongodb-atlas',
        host: verified.host,
        database,
        role,
        readOnly: false,
        region: undefined,
      },
      accountOnly: false,
    }
  }

  async disconnect(ref: ConnectionRef<MongoConn> | null): Promise<void> {
    if (ref) await this.database.dispose?.(ref.conn)
  }

  createConnectionSession(ref: ConnectionRef<MongoConn>): QuerySession {
    return new MongoQuerySession(ref.conn, this.database)
  }
}

function splitCredential(cred: string): { clientId: string; secret: string } {
  const idx = cred.indexOf(':')
  if (idx <= 0 || idx === cred.length - 1) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: 'MongoDB Atlas API key must be formatted as clientId:secret (service account credentials).',
    })
  }
  return { clientId: cred.slice(0, idx), secret: cred.slice(idx + 1) }
}

function translateMongoError(err: unknown): AppError {
  const e = err as { name?: string; message?: string; code?: number }
  const msg = e?.message ?? 'MongoDB connection failed'
  if (e?.name === 'MongoServerSelectionError' || /timed out|timeout/i.test(msg)) {
    return new AppError({ code: 'CONNECTION_FAILED', message: 'Could not reach the MongoDB cluster (selection timeout). Check the host and that the Atlas IP allowlist includes this server.', detail: msg })
  }
  if (e?.name === 'MongoServerError' || e?.code === 18 || /auth/i.test(msg)) {
    return new AppError({ code: 'CONNECTION_FAILED', message: 'MongoDB rejected the credentials or the user is not authorized for this database.', detail: msg })
  }
  if (e?.name === 'MongoNetworkError' || /ECONNREFUSED|ENOTFOUND|socket/i.test(msg)) {
    return new AppError({ code: 'CONNECTION_FAILED', message: 'Could not connect to the MongoDB cluster (network error).', detail: msg })
  }
  return new AppError({ code: 'CONNECTION_FAILED', message: 'MongoDB connection failed.', detail: msg })
}
