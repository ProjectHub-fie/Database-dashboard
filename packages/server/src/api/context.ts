import { Request, Response } from 'express'
import { AuthService } from '../security/auth.js'
import { ProviderSessionManager } from '../security/provider-sessions.js'
import { AuditService } from '../security/audit.js'
import { ProviderRegistryImpl } from '../providers/registry.js'
import { Store } from '../storage/store.js'

export interface AppContext {
  store: Store
  auth: AuthService
  providerSessions: ProviderSessionManager
  audit: AuditService
  registry: ProviderRegistryImpl
}

/** Attach the shared context to every request. */
export function contextMiddleware(ctx: AppContext) {
  return (_req: Request, res: Response, next: () => void) => {
    res.locals.ctx = ctx
    next()
  }
}

export function ctxOf(req: Request): AppContext {
  return (req as unknown as { app: { locals: { ctx: AppContext } } }).app.locals.ctx
}