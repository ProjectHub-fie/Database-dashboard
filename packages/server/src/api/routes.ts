import type { Express, Request, Response } from 'express'
import { sessionMiddleware, requireAuth, csrfProtection, anonymousSession } from './middleware.js'
import { authRouter } from './auth-router.js'
import { providersRouter } from './providers-router.js'
import { connectionsRouter } from './connections-router.js'
import { dataRouter } from './data-router.js'
import { sqlRouter } from './sql-router.js'
import { schemaRouter } from './schema-router.js'
import { controlPlaneRouter } from './control-plane-router.js'
import { auditRouter } from './audit-router.js'
import type { AnonymousSessionStore } from '../security/anon-session.js'

export interface ApiRouteOptions {
  anonSessions: AnonymousSessionStore
  /**
   * `false` disables the dashboard-account requirement for connection routes
   * while keeping per-visitor session isolation and CSRF. Defaults to config.
   */
  authRequired?: boolean
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

  app.use(
    '/api',
    (req, res, next) => {
      if (req.path === '/auth/login') return next()
      if (opts.authRequired === false) return next()
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
