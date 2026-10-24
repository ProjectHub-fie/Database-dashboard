import { NextFunction, Request, Response } from 'express'
import { AppError, asAppError } from '../lib/errors.js'
import { redactObject } from '../lib/redact.js'
import { SESSION_COOKIE, CSRF_COOKIE } from '../security/auth.js'
import { ANON_COOKIE, ANON_CSRF_COOKIE, AnonymousSessionStore } from '../security/anon-session.js'
import { contextMiddleware, ctxOf, AppContext } from './context.js'
import { config } from '../config.js'
import { createLogger } from '../lib/logger.js'

export { contextMiddleware }

const logger = createLogger()

function fail(req: Request, res: Response, error: unknown, ctx: AppContext): void {
  const err = asAppError(error)
  const isServerError = err.status >= 500
  const secretHints = ctx.providerSessions.secretHints(String(req.headers['x-session-ref'] ?? ''))

  const common = {
    err: { code: err.code, status: err.status, message: err.message, detail: err.detail },
    secrets: secretHints,
  }
  if (isServerError) {
    logger.error(redactObject(common, secretHints), `api error ${req.method} ${req.path}`)
  } else {
    logger.warn(redactObject(common, secretHints), `api error ${req.method} ${req.path}`)
  }

  res.status(err.status).json({
    error: { code: err.code, message: err.message },
    requestId: req.headers['x-request-id'],
  })
}

/** Express error handler: always send a safe user-facing message. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  fail(req, res, err, ctxOf(req))
}

/** Install the shared application context on the express app. */
export function installContext(
  app: { locals: { ctx?: AppContext }; use: (m: unknown) => void },
  ctx: AppContext,
): void {
  app.locals.ctx = ctx
  app.use(contextMiddleware(ctx))
}

/** Session middleware: reads the HttpOnly cookie and validates it. */
export function sessionMiddleware(sessionCookieName = SESSION_COOKIE) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = ctxOf(req)
    const raw = req.cookies?.[sessionCookieName]
    if (!raw) return next()
    const account = ctx.auth.validateSession(String(raw))
    if (!account) {
      res.clearCookie(sessionCookieName, cookieOptions(req))
      return next()
    }
    res.locals.sessionRef = account.session.id
    res.locals.userId = account.user.id
    res.locals.account = account
    res.locals.csrf = account.session.csrfToken
    res.locals.authenticated = true
    next()
  }
}

/**
 * Anonymous session resolution, active only while `config.authRequired` is
 * false.
 *
 * It mints the same three locals a dashboard session provides — `sessionRef`,
 * `csrf` and `authenticated` — so downstream code (provider session keying,
 * CSRF double-submit, audit writes) keeps working untouched. `userId` stays
 * unset: an anonymous visitor is not a user, and pretending otherwise would
 * let anonymous state collide with a real account's row ids.
 */
export function anonymousSession(store: AnonymousSessionStore, authRequired = config.authRequired) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Carried on the response so downstream guards (reauth, actor scoping) obey
    // the same setting instead of re-reading global config. Keeps the secured
    // and anonymous configurations testable in one process.
    res.locals.authRequired = authRequired
    if (authRequired || res.locals.authenticated) return next()

    const raw = req.cookies?.[ANON_COOKIE]
    const { session, isNew } = store.resolve(typeof raw === 'string' ? raw : undefined)

    if (isNew) {
      const opts = cookieOptions(req)
      res.cookie(ANON_COOKIE, session.ref, opts)
      // Readable by design: the client echoes it back in `x-csrf-token`.
      res.cookie(ANON_CSRF_COOKIE, session.csrf, { ...opts, httpOnly: false })
    }

    res.locals.sessionRef = session.ref
    res.locals.csrf = session.csrf
    res.locals.authenticated = false
    res.locals.anonymous = true
    next()
  }
}

/** Actor id for owner-scoped work: the user id, or null for anonymous. */
export function actorId(res: Response): number | null {
  return (res.locals.userId as number | undefined) ?? null
}

/**
 * Routes that own per-user rows (saved queries, audit history) cannot serve an
 * anonymous caller — there is no user to own the row. Kept as a guard rather
 * than a route-level delete so enabling auth restores the behaviour exactly.
 */
export function requireUser(_req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.userId) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'This feature needs a dashboard account. Sign in to use saved queries and audit history.',
      },
    })
    return
  }
  next()
}

/** Require an authenticated dashboard session. */
export function requireAuth(_req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.authenticated) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'You must sign in to access this resource' } })
    return
  }
  next()
}

/**
 * CSRF defense: state-changing requests must present both the CSRF cookie and
 * a matching header (double-submit).
 */
export function csrfProtection(opts: { exempt?: (req: Request) => boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    if (opts.exempt?.(req)) return next()
    const expected = res.locals.csrf as string | undefined
    const fromCookie = req.cookies?.[CSRF_COOKIE]
    const header = req.headers['x-csrf-token']
    const supplied = Array.isArray(header) ? header[0] : header
    if (!expected || !fromCookie || supplied !== expected || fromCookie !== expected) {
      return fail(
        req,
        res,
        new AppError({ code: 'FORBIDDEN', message: 'Invalid or missing CSRF token' }),
        ctxOf(req),
      )
    }
    next()
  }
}

/** Reauthentication guard for sensitive operations (deletes, key material).
 * Uses the explicit `reauth_at` clock (set by POST /api/auth/reauth), not the
 * rolling `last_seen_at` idle clock, so everyday activity never masks the
 * reauth requirement. */
export function requireRecentAuth(req: Request, res: Response, next: NextFunction): void {
  const ctx = ctxOf(req)
  const sessionId = res.locals.sessionRef as string | undefined
  if (!sessionId) {
    return fail(req, res, new AppError({ code: 'UNAUTHORIZED', message: 'Not signed in' }), ctx)
  }
  // Reauthentication means re-entering a dashboard password. Anonymous
  // sessions have none, so the check is skipped only while auth is disabled.
  const authRequired = (res.locals.authRequired as boolean | undefined) ?? config.authRequired
  if (!authRequired) return next()
  const ttlMs = config.sessionReauthTtlMs
  const reauthAt = ctx.store.getSessionReauthAt(sessionId)
  if (Date.now() - reauthAt > ttlMs) {
    return fail(
      req,
      res,
      new AppError({
        code: 'NEEDS_REAUTH',
        message: 'Reauthentication required. Confirm your password to continue.',
      }),
      ctx,
    )
  }
  next()
}

export function cookieOptions(_req?: Request) {
  const production = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure:
      production &&
      (process.env.FORCE_SECURE_COOKIES === 'true' || process.env.TRUST_PROXY === 'true'),
    sameSite: 'lax' as const,
    path: '/',
  }
}

export const CSRF_COOKIE_NAME = CSRF_COOKIE
