import express, { NextFunction, Request, Response } from 'express'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { Store } from './storage/store.js'
import { AuthService } from './security/auth.js'
import { AuditService } from './security/audit.js'
import { ProviderSessionManager } from './security/provider-sessions.js'
import { ProviderRegistryImpl } from './providers/registry.js'
import { NeonProvider } from './providers/neon/provider.js'
import { installContext, sessionMiddleware, requireAuth, csrfProtection, errorHandler, anonymousSession } from './api/middleware.js'
import { authRouter } from './api/auth-router.js'
import { connectionsRouter } from './api/connections-router.js'
import { AnonymousSessionStore } from './security/anon-session.js'
import { providersRouter } from './api/providers-router.js'
import { dataRouter } from './api/data-router.js'
import { sqlRouter } from './api/sql-router.js'
import { schemaRouter } from './api/schema-router.js'
import { controlPlaneRouter } from './api/control-plane-router.js'
import { auditRouter } from './api/audit-router.js'
import { forwardAsyncErrors } from './api/async-errors.js'
import { requestLogMiddleware, recentRequests } from './lib/request-log.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const config = loadConfig()

export async function createApp(): Promise<{
  app: express.Express
  store: Store
  auth: AuthService
  sessions: ProviderSessionManager
}> {
  const store = new Store(config.dataDir ? path.join(config.dataDir, 'db-horizon.sqlite') : ':memory:')
  const registry = new ProviderRegistryImpl()
  const provider = new NeonProvider({})
  registry.register(provider)
  const auth = new AuthService(store)
  const audit = new AuditService(store)
  const sessions = new ProviderSessionManager((id) => registry.get(id))
  const anonSessions = new AnonymousSessionStore()
  const ctx = { store, auth, providerSessions: sessions, audit, registry, anonSessions }

  // Bootstrap the initial admin from environment before any listener opens.
  // There is deliberately no default password — this is a no-op when the
  // admin env vars are absent or a user already exists.
  await auth.createInitialAdmin()

  const app = express()
  installContext(app, ctx)
  app.disable('x-powered-by')
  // Trust exactly the configured number of proxy hops; trusting the whole
  // X-Forwarded-For chain would let clients forge their address.
  app.set('trust proxy', config.trustProxy ? config.trustProxyHops : false)

  app.use(
    helmet({
      contentSecurityPolicy:
        config.nodeEnv === 'production'
          ? undefined
          : {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                connectSrc: ["'self'"],
              },
            },
    }),
  )
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  // CORS allowed only for the configured dashboard origin.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-csrf-token, x-request-id, x-session-ref')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  // Request id for tracing and rate-limit keys.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const rid = req.headers['x-request-id'] || crypto.randomUUID()
    res.setHeader('x-request-id', String(rid))
    next()
  })

  // Debug diagnostics: capture method/path/status/duration for every request
  // into a redacted ring buffer, and expose the recent entries for support.
  // Read-only and contains no secrets (paths are truncated, bodies/query/
  // cookies excluded), so it is safe to serve without a login.
  app.use(requestLogMiddleware())
  app.get('/api/debug/requests', (_req: Request, res: Response) => {
    res.json({ requests: recentRequests(100) })
  })

  // Never cache API responses. The API mints the anonymous/session CSRF cookie
  // lazily, and a cached or 304 response (Express ETags, Vercel edge) can drop
  // Set-Cookie — leaving the browser without the `dbh_csrf` cookie and causing
  // spurious "Invalid or missing CSRF token" 403s on the first state-changing
  // request. Session endpoints must also never be stored by intermediaries.
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    next()
  })

  // Global rate limit (sane defaults; tightened per-route where relevant).
  app.use(
    '/api/',
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } })
      },
    }),
  )

  // Auth: session resolution for every API route; login is public but
  // rate-limited. Every other API route requires an authenticated dashboard
  // session + CSRF token for state-changing requests.
  app.use('/api', sessionMiddleware())
  // When auth is disabled, every browser still gets an isolated session ref so
  // provider credentials stay per-visitor instead of becoming process-global.
  app.use('/api', anonymousSession(anonSessions))
  app.use('/api/auth', authRouter())
  // Public catalog: describes which providers exist and which auth methods they
  // implement. Contains no secrets, and the login screen needs it before sign-in
  // so the provider selector is driven by the registry instead of a UI table.
  app.use('/api/providers', providersRouter())
  app.use(
    '/api',
    (req, res, next) => {
      // Login is deliberately public (it creates the session).
      if (req.path === '/auth/login') return next()
      // Authentication is temporarily optional: the check is intact, the flag
      // only decides whether it runs. Set AUTH_REQUIRED=true to enforce it.
      if (!config.authRequired) return next()
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

  // Health probe used by orchestrators (no auth).
  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  // Serve built frontend in production.
  const dist = path.resolve(__dirname, '../../client/dist')
  if (config.serveClient) {
    app.use(express.static(dist))
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
  }

  app.use(errorHandler)

  // Express 4 does not forward async handler rejections; wire the fix before
  // anything can hang a request.
  forwardAsyncErrors(app)

  // Idle sweep + login throttle timers are owned by the process, not per-app.
  runBackgroundJobs(sessions)

  return { app, store, auth, sessions }
}

let backgroundHandler: ReturnType<typeof setInterval> | null = null
function runBackgroundJobs(sessions: ProviderSessionManager): void {
  if (backgroundHandler) clearInterval(backgroundHandler)
  backgroundHandler = setInterval(() => {
    void sessions.sweepIdle(config.idleSessionTtlMs)
  }, 60_000)
}

if (process.env.NODE_ENV !== 'test') {
  // The CSRF and session tokens are HMACs under COOKIE_SECRET (see
  // security/anon-session.ts). A default secret is predictable, which would let
  // anyone forge a session, and a per-instance secret would make a cookie minted
  // by one host fail on another. Refuse to run in production without it.
  if (config.nodeEnv === 'production' && config.cookieSecret === 'dev-insecure-secret-change-me') {
    // eslint-disable-next-line no-console
    console.error('COOKIE_SECRET must be set to a long random value in production')
    process.exit(1)
  }

  void createApp()
    .then(({ app, store }) => {
      app.listen(config.port, config.host, () => {
        // eslint-disable-next-line no-console
        console.log(`DB Horizon API listening on http://${config.host}:${config.port}`)
      })

      const gracefulShutdown = (signal: string) => {
        // eslint-disable-next-line no-console
        console.log(`Received ${signal}, shutting down`)
        if (backgroundHandler) clearInterval(backgroundHandler)
        store.close()
        process.exit(0)
      }
      process.on('SIGINT', () => gracefulShutdown('SIGINT'))
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Fatal: failed to start DB Horizon', err)
      process.exit(1)
    })
}

export default createApp