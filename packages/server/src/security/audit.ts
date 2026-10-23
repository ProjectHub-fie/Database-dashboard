import { Store, AuditEvent } from '../storage/store.js'
import { redact } from '../lib/redact.js'
import { createLogger } from '../lib/logger.js'

export type AuditStatus = 'ok' | 'fail' | 'warn' | 'info'

/**
 * Audit service. Events are stored per-user. All detail fields are run through
 * secret redaction before persistence so credentials never enter the audit log.
 */
export class AuditService {
  constructor(
    private readonly store: Store,
    private readonly opts: { logger?: ReturnType<typeof createLogger> } = {},
  ) {
    opts.logger = opts.logger ?? createLogger()
    this.opts = opts
  }

  isEnabled(): boolean {
    return this.store.getAuditSettings().enabled
  }

  /**
   * Record an audit event. `detail` may contain sensitive values — every field
   * is redacted with the provided secret values before storage.
   */
  write(input: {
    userId: number | null
    sessionId: string | null
    event: string
    status: AuditStatus
    target?: string | null
    detail?: string | null
  }): void {
    const settings = this.store.getAuditSettings()
    if (!settings.enabled) return
    const secretValues: string[] = []
    if (input.detail) secretValues.push(input.detail)
    const event: Omit<AuditEvent, 'id'> = {
      userId: input.userId,
      sessionId: input.sessionId,
      event: input.event,
      actor: String(input.userId ?? 'anonymous'),
      status: input.status,
      target: input.target ?? null,
      detail: input.detail ? redact(input.detail, { secrets: secretValues }) : null,
      createdAt: Date.now(),
    }
    this.store.writeAudit(event)
  }

  /**
   * Always-on structured log line, independent of the store-level audit
   * setting. Used for operations that must be traceable even when an operator
   * disabled the persisted audit log. Detail is redacted before logging.
   */
  writeLogOnly(input: {
    event: string
    userId?: number | null
    status: string
    detail?: string
  }): void {
    this.opts.logger?.info(
      {
        audit: input.event,
        userId: input.userId ?? null,
        status: input.status,
        detail: input.detail ? redact(input.detail) : undefined,
      },
      'audit event',
    )
  }

  list(input: { limit: number; offset: number; event?: string }): { rows: AuditEvent[]; total: number } {
    return this.store.listAudit(input)
  }

  events(): string[] {
    return this.store.listAuditEvents()
  }

  pruneIfNeeded(): void {
    const now = Date.now()
    const settings = this.store.getAuditSettings()
    if (settings.retentionDays > 0) {
      const removed = this.store.pruneAudit(now, settings.retentionDays)
      if (removed > 0) this.opts.logger?.info({ removed }, 'pruned old audit rows')
    }
  }
}