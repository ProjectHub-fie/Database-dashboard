import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { ctxOf } from './context.js'
import { AppError } from '../lib/errors.js'
import { SessionAccount } from '../security/auth.js'

const createUserSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(12).max(200),
})

export interface AdminRouterOptions {
  /** Base URLs of separate API deployments to probe from the admin portal. */
  adminApiOrigins: string[]
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
  } catch {
    return false
  }
}

/**
 * Origins to probe: the configured `adminApiOrigins` win; otherwise fall back
 * to the origin this request actually arrived on (its proxy proto + host), so
 * the portal still works when `API_ORIGIN` is unset (local dev). Command-safe:
 * only http(s) URLs without embedded credentials are accepted.
 */
export function originsFor(req: Request, configured: string[]): string[] {
  const fromRequest: string[] = []
  const proto = req.headers['x-forwarded-proto'] ?? 'http'
  const host = req.headers.host
  if (typeof proto === 'string' && typeof host === 'string') {
    fromRequest.push(`${proto}://${host}`)
  }
  const merged = configured.length > 0 ? configured : fromRequest
  return [...new Set(merged.filter(isHttpUrl))]
}

function requireAdmin(_req: Request, res: Response, next: () => void): void {
  const account = res.locals.account as SessionAccount | undefined
  if (!account || account.user.role !== 'admin') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin role required' } })
    return
  }
  next()
}

/**
 * Administration portal API. Everything here needs a real dashboard account
 * with the `admin` role (all accounts provisioned by this dashboard are admins).
 *
 * `POST /users` is deliberately rate-limited by the global `/api` limiter and
 * the CSRF-protected write path; there is no open signup surface.
 */
export function adminRouter(opts: AdminRouterOptions): Router {
  const router = Router()

  router.use(requireAdmin)

  // GET /api/admin/env — which API origins are configured for probing.
  router.get('/env', (req: Request, res: Response) => {
    res.json({ adminApiOrigins: originsFor(req, opts.adminApiOrigins) })
  })

  // GET /api/admin/users — list dashboard accounts. Never password hashes.
  router.get('/users', (_req: Request, res: Response) => {
    const users = ctxOf(_req)
      .store.listUsers()
      .map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        createdAt: u.createdAt,
        mustChangePassword: Boolean(u.mustChangePassword),
      }))
    res.json({ users })
  })

  // POST /api/admin/users — create a dashboard account. The password is hashed
  // (Argon2id) before it touches the store; the raw value never leaves the
  // request body.
  router.post('/users', async (req: Request, res: Response) => {
    const parsed = createUserSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message:
          'Username must be 3-64 characters of A-Z a-z 0-9 _ . - and the password at least 12 characters.',
      })
    }
    const { username, password } = parsed.data
    const { store, auth } = ctxOf(req)
    if (store.getUserByUsername(username)) {
      throw new AppError({ code: 'CONFLICT', message: `User "${username}" already exists` })
    }
    const hash = await auth.hashPassword(password)
    const user = store.createUser(username, hash, 'admin')
    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
        mustChangePassword: Boolean(user.mustChangePassword),
      },
    })
  })

  // GET /api/admin/checks — self-check and probe each configured API origin.
  // This is the "test both API origins" view: the server performs a real HTTP
  // request to each origin's /api/healthz and reports status + latency so an
  // operator can confirm both deployments are serving the same API.
  router.get('/checks', async (req: Request, res: Response) => {
    const checks = await Promise.all(originsFor(req, opts.adminApiOrigins).map(probeOrigin))
    res.json({ checks })
  })

  return router
}

async function probeOrigin(origin: string): Promise<OriginProbe> {
  const base = origin.replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    return { origin, ok: false, httpStatus: 0, latencyMs: 0, body: null, error: 'Invalid origin URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { origin, ok: false, httpStatus: 0, latencyMs: 0, body: null, error: 'Origin must be http(s)' }
  }
  if (parsed.username || parsed.password) {
    return { origin, ok: false, httpStatus: 0, latencyMs: 0, body: null, error: 'Origin must not embed credentials' }
  }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(`${base}/api/healthz`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return {
      origin,
      ok: response.ok,
      httpStatus: response.status,
      latencyMs: Date.now() - started,
      body,
      error: null,
    }
  } catch (err) {
    return {
      origin,
      ok: false,
      httpStatus: 0,
      latencyMs: Date.now() - started,
      body: null,
      error: err instanceof Error ? (err.name === 'TimeoutError' || err.name === 'AbortError' ? 'Timed out after 5s' : err.message) : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface OriginProbe {
  origin: string
  ok: boolean
  httpStatus: number
  latencyMs: number
  body: unknown
  error: string | null
}