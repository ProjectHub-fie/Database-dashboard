/**
 * Test harness helpers. Use in-memory store and a mock Neon HTTP client that
 * answers predictable fixtures so tests never hit the real network.
 */
import express from 'express'
import cookieParser from 'cookie-parser'
import { Store } from '../storage/store.js'
import { AuthService } from '../security/auth.js'
import { AuditService } from '../security/audit.js'
import { ProviderSessionManager } from '../security/provider-sessions.js'
import { ProviderRegistryImpl } from '../providers/registry.js'
import { NeonProvider } from '../providers/neon/provider.js'
import { NeonHttpClient, NeonApiError } from '../providers/neon/client.js'
import { installContext, errorHandler } from '../api/middleware.js'
import { AnonymousSessionStore } from '../security/anon-session.js'
import { registerApiRoutes } from '../api/routes.js'
import { forwardAsyncErrors } from '../api/async-errors.js'
import { requestLogMiddleware, recentRequests } from '../lib/request-log.js'

export interface MockNeonHttpClient extends NeonHttpClient {
  _seenKeys: Set<string>
  _requests: Array<{ method: string; path: string; body: unknown }>
  _setHandler(method: string, path: string, handler: (body: unknown, params: Record<string, string>) => unknown): void
}

/** Build a Neon HTTP client that responds to whitelisted path patterns. */
export function mockNeonHttp(): MockNeonHttpClient {
  const seenKeys = new Set<string>()
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  const handlers = new Map<string, (body: unknown, params: Record<string, string>) => unknown>()

  return {
    _seenKeys: seenKeys,
    _requests: requests,
    _setHandler(method, path, handler) {
      handlers.set(`${method.toUpperCase()} ${path}`, handler)
    },
    async request<T>(opts: NeonHttpClient['request'] extends (o: infer O) => unknown ? O : never) {
      seenKeys.add(opts.apiKey)
      requests.push({ method: opts.method.toUpperCase(), path: opts.path, body: opts.body })
      const key = `${opts.method.toUpperCase()} ${opts.path}`
      let match: { handler: (body: unknown, params: Record<string, string>) => unknown; params: Record<string, string> } | null = null
      for (const [pattern, handler] of handlers) {
        const parts = pattern.split('/').filter(Boolean)
        const got = key.split('/').filter(Boolean)
        if (parts.length !== got.length) continue
        const params: Record<string, string> = {}
        let ok = true
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]!
          const g = got[i]!
          if (p.startsWith(':')) params[p.slice(1)] = g
          else if (p !== g) {
            ok = false
            break
          }
        }
        if (ok) {
          match = { handler, params }
          break
        }
      }
      if (!match) {
        throw new NeonApiError({
          message: `Unexpected Neon API request ${opts.method} ${opts.path}`,
          providerStatus: 404,
        })
      }
      const out = match.handler(opts.body, match.params)
      return out as T
    },
  }
}

/**
 * Build an app instance for tests.
 *
 * `authRequired` defaults to true: the security suite asserts that unauthenticated
 * callers are rejected, so the harness must model the *secured* configuration.
 * Anonymous-mode tests opt in explicitly with `authRequired: false`.
 */
export async function makeTestApp(
  opts: { neonHttp?: MockNeonHttpClient; authRequired?: boolean } = {},
): Promise<{
  app: express.Express
  store: Store
  auth: AuthService
  audit: AuditService
  sessions: ProviderSessionManager
  neon: MockNeonHttpClient
}> {
  const store = new Store(':memory:')
  const auth = new AuthService(store)
  const audit = new AuditService(store)
  const registry = new ProviderRegistryImpl()
  const neonHttp = opts.neonHttp ?? mockNeonHttp()
  const provider = new NeonProvider({ http: neonHttp, skipConnectionUrlHostValidation: true })
  registry.register(provider)
  const sessions = new ProviderSessionManager((id) => registry.get(id))
  const anonSessions = new AnonymousSessionStore()
  const ctx = { store, auth, providerSessions: sessions, audit, registry, anonSessions }

  const app = express()
  installContext(app, ctx)
  app.disable('x-powered-by')
  app.use(cookieParser())
  app.use(express.json({ limit: '1mb' }))
  app.use(requestLogMiddleware())
  app.get('/api/debug/requests', (_req, res) => res.json({ requests: recentRequests(100) }))
  registerApiRoutes(app, { anonSessions, authRequired: opts.authRequired ?? true })
  app.use(errorHandler)
  forwardAsyncErrors(app)
  return { app, store, audit, auth, sessions, neon: neonHttp }
}

/** Create a user in the store directly (bypass Argon2 for speed) + return login creds. */
export async function seedUser(
  store: Store,
  username = 'tester',
  password = 'correct-horse-battery-staple!',
): Promise<{ username: string; password: string }> {
  const hash = await new AuthService(store).hashPassword(password)
  store.createUser(username, hash)
  return { username, password }
}

/**
 * Full authentication round-trip via supertest. Returns everything a test needs
 * to act as an authenticated user (cookies + CSRF token).
 */
export async function login(
  app: express.Express,
  username: string,
  password: string,
): Promise<{ agent: TestAgent; csrfToken: string; csrfCookie: string }> {
  const agent = new TestAgent(app)
  const res = await agent.post('/api/auth/login', { username, password })
  const cookies = agent.cookies
  const csrfRaw = cookies.find((c) => c.startsWith('dbh_csrf='))
  const csrfToken = csrfRaw ? decodeURIComponent(csrfRaw.split('=').slice(1).join('=').split(';')[0] ?? '') : ''
  void res
  return { agent, csrfToken, csrfCookie: csrfRaw?.split(';')[0] ?? '' }
}

/** Minimal supertest wrapper so tests don't hardcode cookie juggling. */
export class TestAgent {
  cookies: string[] = []

  constructor(private readonly app: express.Express) {}

  private header(): Record<string, string> {
    return this.cookies.length ? { Cookie: this.cookies.join('; ') } : {}
  }

  async get(path: string): Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }> {
    const supertest = (await import('supertest')).default
    const res = await supertest(this.app).get(path).set(this.header())
    this.persist(res)
    return { status: res.status, body: res.body, text: res.text, headers: res.headers }
  }

  async post(
    path: string,
    body?: Record<string, unknown> | null,
    csrfToken?: string,
  ): Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }> {
    const supertest = (await import('supertest')).default
    let req = supertest(this.app).post(path).set(this.header())
    if (csrfToken) req = req.set('x-csrf-token', csrfToken)
    if (body !== undefined && body !== null) req = req.send(body)
    const res = await req
    this.persist(res)
    return { status: res.status, body: res.body, text: res.text, headers: res.headers }
  }

  async put(
    path: string,
    body?: Record<string, unknown> | null,
    csrfToken?: string,
  ): Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }> {
    const supertest = (await import('supertest')).default
    let req = supertest(this.app).put(path).set(this.header())
    if (csrfToken) req = req.set('x-csrf-token', csrfToken)
    if (body !== undefined && body !== null) req = req.send(body)
    const res = await req
    this.persist(res)
    return { status: res.status, body: res.body, text: res.text, headers: res.headers }
  }

  async delete(path: string, csrfToken?: string): Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }> {
    const supertest = (await import('supertest')).default
    let req = supertest(this.app).delete(path).set(this.header())
    if (csrfToken) req = req.set('x-csrf-token', csrfToken)
    const res = await req
    this.persist(res)
    return { status: res.status, body: res.body, text: res.text, headers: res.headers }
  }

  private persist(res: { headers: { 'set-cookie'?: unknown } }): void {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined
    if (set && Array.isArray(set)) {
      for (const c of set) {
        const name = c.split('=')[0] ?? ''
        const i = this.cookies.findIndex((x) => x.startsWith(`${name}=`))
        const withoutAttrs = c.split(';')[0] ?? ''
        if (i >= 0) this.cookies[i] = withoutAttrs
        else this.cookies.push(withoutAttrs)
      }
    }
  }
}

export { installContext }