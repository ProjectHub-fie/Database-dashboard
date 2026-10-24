import { ConnectionRef, ControlPlaneAdapter, Provider, ProviderCapabilities, QuerySession } from '../providers/types.js'
import { AppError } from '../lib/errors.js'
import { redact } from '../lib/redact.js'
import { createLogger } from '../lib/logger.js'

/** Safe, non-secret metadata shown in the UI. */
export interface ConnectionMetadataView {
  host: string
  database: string
  role: string
  readOnly: boolean
  /** Optional operator label; never a credential. */
  displayName?: string
  projectId?: string
  projectName?: string
  branchId?: string
  branchName?: string
}

export interface ProviderSession {
  readonly sessionId: string
  /** Owning dashboard user, or null for an anonymous connection session. */
  readonly userId: number | null
  providerId: string
  auth: 'connection' | 'api'
  /** In-memory credential hints for redaction. Never persisted. */
  secretHints: string[]
  connection: ConnectionRef<unknown> | null
  controlPlane: ControlPlaneAdapter | null
  accountOnly: boolean
  metadata: ConnectionMetadataView | null
  usage: { usageUntil?: number }
  createdAt: number
  lastActive: number
  activeQuerySessions: Set<QuerySession>
  /** Persistent query session over this provider's connection (for transactions). */
  primaryQuerySession: QuerySession | null
}

/** Marker on the session so route handlers can clean up per-request sessions. */
export interface QueryAllocation {
  session: ProviderSession
  qs: QuerySession
  shared: boolean
}

/**
 * Per-user, per-session provider state. Credentials live in memory only, keyed
 * by the dashboard session id; they are wiped on disconnect / logout.
 */
export class ProviderSessionManager {
  private readonly sessions = new Map<string, ProviderSession>()
  private readonly logger = createLogger()

  constructor(private readonly getProvider: (id: string) => Provider<unknown> | undefined) {}

  create(input: {
    sessionId: string
    userId: number | null
    providerId: string
    auth: 'connection' | 'api'
    connection: ConnectionRef<unknown> | null
    controlPlane: ControlPlaneAdapter | null
    accountOnly: boolean
    metadata: ProviderSession['metadata']
    secretHints: string[]
    usageUntil?: number
  }): ProviderSession {
    const existing = this.sessions.get(input.sessionId)
    if (existing) this.destroy(existing).catch(() => undefined)
    const session: ProviderSession = {
      sessionId: input.sessionId,
      userId: input.userId,
      providerId: input.providerId,
      auth: input.auth,
      secretHints: input.secretHints,
      connection: input.connection,
      controlPlane: input.controlPlane,
      accountOnly: input.accountOnly,
      metadata: input.metadata,
      usage: input.usageUntil ? { usageUntil: input.usageUntil } : {},
      createdAt: Date.now(),
      lastActive: Date.now(),
      activeQuerySessions: new Set(),
      primaryQuerySession: null,
    }
    this.sessions.set(input.sessionId, session)
    return session
  }

  get(sessionId: string): ProviderSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** Verify that a provider session belongs to the given dashboard user. */
  require(sessionId: string, userId: number | null): ProviderSession {
    const s = this.sessions.get(sessionId)
    if (!s) {
      throw new AppError({ code: 'UNAUTHORIZED', message: 'No active database session. Connect first.' })
    }
    if (s.userId !== userId) {
      // Cross-user access attempt — hard deny.
      throw new AppError({ code: 'FORBIDDEN', message: 'Session isolation violation' })
    }
    return s
  }

  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.lastActive = Date.now()
  }

  /** Tear down the provider session on dashboard session revocation (logout). */
  async destroyForSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (s) await this.destroy(s)
  }

  /** Close provider connections that have been idle too long. Returns closed count. */
  async sweepIdle(idleMs: number): Promise<number> {
    const now = Date.now()
    const doomed = [...this.sessions.values()].filter((s) => now - s.lastActive > idleMs)
    await Promise.allSettled(doomed.map((s) => this.destroy(s)))
    return doomed.length
  }

  registerQuerySession(reference: string, qs: QuerySession): void {
    const s = this.sessions.get(reference)
    if (s) s.activeQuerySessions.add(qs)
  }

  /** Obtain (or lazily create) the persistent query session for a provider session. */
  async allocatePrimary(reference: string, userId: number | null): Promise<QueryAllocation> {
    const s = this.require(reference, userId)
    if (!s.primaryQuerySession) {
      const provider = this.getProvider(s.providerId)
      if (!provider || !s.connection) {
        // Not UNAUTHORIZED: the dashboard session is perfectly valid, this
        // connection mode simply has no SQL surface. A 401 here made the client
        // treat an API-key session as a lost connection and drop the operator
        // back to the connect screen on their first click of any data page.
        throw new AppError({
          code: s.accountOnly ? 'FEATURE_UNAVAILABLE' : 'UNAUTHORIZED',
          message: s.accountOnly
            ? 'No database is attached to this session yet. Open the Databases page and choose “Use database” to run SQL, browse data or manage the schema.'
            : 'No live database connection is available',
        })
      }
      const qs = provider.createConnectionSession(s.connection)
      s.primaryQuerySession = qs
      s.activeQuerySessions.add(qs)
    }
    return { session: s, qs: s.primaryQuerySession, shared: true }
  }

  /**
   * Bind a database connection to an existing session (API-key mode picking a
   * project/branch/database). Any previous connection is closed first so a
   * switch never leaks a pool or keeps querying the wrong database.
   */
  async attachConnection(
    reference: string,
    userId: number | null,
    input: {
      connection: ConnectionRef<unknown>
      metadata: ConnectionMetadataView
      secretHints: readonly string[]
    },
  ): Promise<ProviderSession> {
    const s = this.require(reference, userId)
    const previous = s.connection
    if (previous) {
      await this.closeQuerySessions(s)
      const provider = this.getProvider(s.providerId)
      await provider?.disconnect(previous).catch(() => undefined)
    }
    s.connection = input.connection
    s.accountOnly = false
    s.metadata = input.metadata
    s.secretHints = [...new Set([...s.secretHints, ...input.secretHints.filter((v) => v.length > 0)])]
    return s
  }

  /** Drop the database connection but keep the control-plane credential alive. */
  async detachConnection(reference: string, userId: number | null): Promise<ProviderSession> {
    const s = this.require(reference, userId)
    const previous = s.connection
    if (previous) {
      await this.closeQuerySessions(s)
      const provider = this.getProvider(s.providerId)
      await provider?.disconnect(previous).catch(() => undefined)
    }
    s.connection = null
    s.accountOnly = true
    return s
  }

  /** Close the persistent query session (used for transaction reset). */
  async closePrimary(reference: string): Promise<void> {
    const s = this.sessions.get(reference)
    if (!s?.primaryQuerySession) return
    const qs = s.primaryQuerySession
    s.primaryQuerySession = null
    s.activeQuerySessions.delete(qs)
    await qs.close().catch(() => undefined)
  }

  async closeQuerySessions(session: ProviderSession): Promise<void> {
    const list = [...session.activeQuerySessions]
    session.activeQuerySessions.clear()
    session.primaryQuerySession = null
    await Promise.allSettled(list.map((qs) => qs.close()))
  }

  async destroy(session: ProviderSession): Promise<void> {
    this.sessions.delete(session.sessionId)
    await this.closeQuerySessions(session)
    const provider = this.getProvider(session.providerId)
    if (session.connection && provider) {
      const p = session.connection
      try {
        await provider.disconnect(session.connection)
        this.logger.info(
          { provider: session.providerId, connection: p.id },
          'disconnected provider connection',
        )
      } catch (err) {
        this.logger.warn(
          {
            provider: session.providerId,
            err: redact(err, { secrets: session.secretHints }),
          },
          'error while disconnecting provider connection',
        )
      }
    }
    session.connection = null
    session.controlPlane = null
    session.secretHints = []
  }

  async destroyAllForUser(userId: number): Promise<void> {
    const doomed = [...this.sessions.values()].filter((s) => s.userId === userId)
    await Promise.allSettled(doomed.map((s) => this.destroy(s)))
  }

  async destroyAll(): Promise<void> {
    const doomed = [...this.sessions.values()]
    await Promise.allSettled(doomed.map((s) => this.destroy(s)))
  }

  capabilities(sessionId: string): ProviderCapabilities | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    return this.getProvider(s.providerId)?.capabilities()
  }

  secretHints(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.secretHints ?? []
  }

  count(): number {
    return this.sessions.size
  }
}