import type { Express, Request, Response } from 'express'
import { sessionMiddleware, requireAuth, csrfProtection, anonymousSession } from './middleware.js'
import { ctxOf } from './context.js'
import { authRouter } from './auth-router.js'
import { providersRouter } from './providers-router.js'
import { connectionsRouter } from './connections-router.js'
import { dataRouter } from './data-router.js'
import { sqlRouter } from './sql-router.js'
import { schemaRouter } from './schema-router.js'
import { controlPlaneRouter } from './control-plane-router.js'
import { auditRouter } from './audit-router.js'
import { adminRouter } from './admin-router.js'
import type { AnonymousSessionStore } from '../security/anon-session.js'

/**
 * URL-mode paths that must always demand a real dashboard account. A pasted
 * database URL grants direct SQL access, so it is never allowed on an
 * anonymous ref.
 */
const URL_ONLY_PATHS = new Set(['/connections/url', '/connections/preview'])

/**
 * Whether a request may pass the account gate solely on the strength of a
 * provider session bound to its (possibly anonymous) session ref. This is the
 * public provider-API-key path: the key is the credential, the ref isolates
 * it, and the provider's own permissions authorize it. URL-mode entry points
 * are excluded even when a session already exists so an anonymous API-key
 * holder cannot silently switch to URL mode.
 */
function publicApiKeyCallAllowed(req: Request, res: Response): boolean {
  if (URL_ONLY_PATHS.has(req.path)) return false
  // The connect call establishes the session, so there is nothing to hold yet;
  // it is the public entry point for API-key mode.
  if (req.method === 'POST' && req.path === '/connections/api') return true
  if (!res.locals.sessionRef) return false
  return ctxOf(req).providerSessions.has(String(res.locals.sessionRef))
}

export interface ApiRouteOptions {
  anonSessions: AnonymousSessionStore
  /**
   * `false` disables the dashboard-account requirement for connection routes
   * while keeping per-visitor session isolation and CSRF. Defaults to config.
   */
  authRequired?: boolean
  /** Base URLs probed by the admin portal to verify both API origins. */
  adminApiOrigins?: string[]
}

/**
 * The single place `/api` routes are mounted.
 *
 * Both the real server (`index.ts`) and the test harness register routes through
 * this function. They used to assemble their own copies, which let the two drift:
 * a route could exist in production but not in tests (or the reverse), and only
 * the deployed app would 404. Anything mounted under `/api` belongs here.
 */
export function registerApiRoutes(app: Express, opts: ApiRouteOptions): void {
  app.use('/api', sessionMiddleware())
  // Without authentication every browser still gets its own session ref, so
  // provider credentials stay per-visitor instead of becoming process-global.
  app.use('/api', anonymousSession(opts.anonSessions, opts.authRequired ?? true))

  app.use('/api/auth', authRouter())
  // Public catalog: describes which providers exist and which auth methods they
  // implement. Contains no secrets, and the login screen needs it before sign-in.
  app.use('/api/providers', providersRouter())

  /**
   * Provider API-key mode is public by design, even under AUTH_REQUIRED=true:
   * the operator supplies their own key, it is bound to their anonymous session
   * ref (`anonymousSession` above), and the provider's own permissions decide
   * what the key can do. A caller that already holds a provider session for its
   * ref is allowed through the account gate — the provider session *is* the
   * authorization, and the route handlers enforce ownership. URL-mode entry
   * points (`/connections/url`, `/connections/preview`) are excluded so a
   * pasted database URL still requires a real dashboard account.
   */
  app.use(
    '/api',
    (req, res, next) => {
      // Public surfaces that must stay reachable before any session or
      // account gate. `/auth/login` is the anonymous account entry point;
      // `/healthz` is the deployment probe — Vercel proxies only `/api/*`
      // to this origin, so the proxy-health check the admin portal and
      // `scripts/check-deploy.sh --api` rely on must answer 200 even when
      // AUTH_REQUIRED=true. `/healthz` (outside the gate) is already public;
      // this keeps the API-prefixed twin public too.
      if (req.path === '/auth/login' || req.path === '/healthz') return next()
      if (opts.authRequired === false) return next()
      if (publicApiKeyCallAllowed(req, res)) return next()
      return requireAuth(req, res, next)
    },
    csrfProtection({ exempt: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) }),
  )

  app.use('/api/connections', connectionsRouter())
  app.use('/api/data', dataRouter())
  app.use('/api/sql', sqlRouter())
  app.use('/api/schema', schemaRouter())
  app.use('/api/control', controlPlaneRouter())
  app.use('/api/audit', auditRouter())
  app.use('/api/admin', adminRouter({ adminApiOrigins: opts.adminApiOrigins ?? [] }))

  // `/api/healthz` is the same probe reached through the deployment's /api
  // proxy, so one request proves the proxy function AND the upstream API are
  // both alive. Registered before the catch-all below, which would otherwise
  // swallow it.
  app.get(['/healthz', '/api/healthz'], (_req, res) => res.json({ ok: true }))

  // Unmatched `/api` path. Express's default HTML page breaks the JSON contract:
  // the client cannot tell "no such route" from "the hosting platform never
  // built the API", and reports a bare "Request failed (404)".
  app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `No API route for ${req.method} /api${req.path}`,
      },
      requestId: req.headers['x-request-id'],
    })
  })
}
