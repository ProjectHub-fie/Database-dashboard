import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../lib/errors.js'
import { SessionAccount } from '../security/auth.js'
import { ctxOf } from './context.js'
import { config } from '../config.js'
import {
  cookieOptions,
  SESSION_COOKIE_OPTION,
  CSRF_COOKIE_OPTION,
  AppCookieOptions,
} from './cookies.js'
import { sessionMiddleware, csrfProtection } from './middleware.js'

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
})

const reauthSchema = z.object({ password: z.string().min(1).max(512) })

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(12).max(512),
})

export function authRouter(): Router {
  const router = Router()

  // POST /api/auth/login — rate-limited separately in index.ts.
  router.post('/login', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const parsed = loginSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Username and password are required' })
    }
    const { username, password } = parsed.data
    const user = await ctx.auth.authenticate(username, password)
    const created = ctx.auth.createSession(user, { ip: req.socket.remoteAddress })
    const opts = cookieOptions(req)

    res.locals.sessionRef = created.session.id
    res.locals.userId = user.id
    res.locals.csrf = created.session.csrfToken
    res.locals.account = { session: created.session, user }
    res.locals.authenticated = true

    res.cookie(SESSION_COOKIE_OPTION, created.rawToken, opts)
    res.cookie(CSRF_COOKIE_OPTION, created.session.csrfToken, { ...opts, httpOnly: false })

    ctx.audit.write({
      userId: user.id,
      sessionId: created.session.id,
      event: 'auth.login',
      status: 'ok',
      target: username,
    })

    res.json({
      authenticated: true,
      authRequired: config.authRequired,
      user: {
        id: user.id,
        username: user.username,
        mustChangePassword: Boolean(user.mustChangePassword),
      },
    })
  })

  // POST /api/auth/logout — revoke the dashboard session and close connections.
  router.post('/logout', csrfProtection(), (req: Request, res: Response) => {
    void req
    const ctx = ctxOf(req)
    const sessionId = res.locals.sessionRef as string | undefined
    if (sessionId) {
      ctx.auth.revokeSession(sessionId)
      void ctx.providerSessions.destroyForSession(sessionId)
      ctx.audit.write({
        userId: res.locals.userId ?? null,
        sessionId,
        event: 'auth.logout',
        status: 'ok',
      })
    }
    clearSessionCookies(res)
    res.json({ ok: true })
  })

  // POST /api/auth/reauth — re-verify the password for sensitive operations.
  router.post('/reauth', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const parsed = reauthSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new AppError({ code: 'BAD_REQUEST', message: 'Password required' })
    const userId = res.locals.userId as number | undefined
    if (!userId) throw new AppError({ code: 'UNAUTHORIZED', message: 'Not signed in' })
    const sessionId = res.locals.sessionRef as string
    const user = ctx.store.getUserById(userId)
    if (!user) throw new AppError({ code: 'UNAUTHORIZED', message: 'Account not found' })
    const ok = await ctx.auth.verifyPassword(user.passwordHash, parsed.data.password)
    if (!ok) {
      ctx.audit.write({ userId, sessionId, event: 'auth.reauth', status: 'fail' })
      throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid password' })
    }
    ctx.store.markReauthed(sessionId, Date.now())
    ctx.audit.write({ userId, sessionId, event: 'auth.reauth', status: 'ok' })
    res.json({ ok: true, reauthUntil: Date.now() + config.sessionReauthTtlMs })
  })

  // POST /api/auth/change-password — rotate the dashboard account password.
  // Requires the current password, then revokes every other session so a
  // stolen cookie cannot outlive the rotation.
  router.post('/change-password', async (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    const parsed = changePasswordSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'Current password and a new password of at least 12 characters are required',
      })
    }
    const userId = res.locals.userId as number | undefined
    const sessionId = res.locals.sessionRef as string | undefined
    if (!userId || !sessionId) throw new AppError({ code: 'UNAUTHORIZED', message: 'Not signed in' })

    const user = ctx.store.getUserById(userId)
    if (!user) throw new AppError({ code: 'UNAUTHORIZED', message: 'Account not found' })

    const { currentPassword, newPassword } = parsed.data
    const ok = await ctx.auth.verifyPassword(user.passwordHash, currentPassword)
    if (!ok) {
      ctx.audit.write({ userId, sessionId, event: 'auth.change_password', status: 'fail' })
      throw new AppError({ code: 'UNAUTHORIZED', message: 'Current password is incorrect' })
    }
    if (currentPassword === newPassword) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'New password must differ from the current one' })
    }

    ctx.store.updatePassword(userId, await ctx.auth.hashPassword(newPassword))
    ctx.store.revokeAllSessions(userId, sessionId)
    ctx.store.markReauthed(sessionId, Date.now())
    ctx.audit.write({ userId, sessionId, event: 'auth.change_password', status: 'ok' })

    res.json({ ok: true })
  })

  // GET /api/auth/me — current account + session state.
  router.get('/me', sessionMiddleware(), (req: Request, res: Response) => {
    const ctx = ctxOf(req)
    void req
    if (!res.locals.authenticated) {
      // authRequired lets the UI keep connection screens reachable while the
      // account requirement is disabled; it is not a client-side permission.
      res.json({ authenticated: false, authRequired: config.authRequired, anonymous: Boolean(res.locals.anonymous) })
      return
    }
    const account = res.locals.account as SessionAccount
    ctx.providerSessions.touch(String(res.locals.sessionRef))
    // Never leak password hashes, roles or session internals to the browser.
    res.json({
      authenticated: true,
      user: {
        id: account.user.id,
        username: account.user.username,
        mustChangePassword: Boolean(account.user.mustChangePassword),
      },
    })
  })

  return router
}

function clearSessionCookies(res: Response): void {
  const opts: AppCookieOptions = cookieOptions()
  res.clearCookie(SESSION_COOKIE_OPTION, opts)
  res.clearCookie(CSRF_COOKIE_OPTION, { ...opts, httpOnly: false })
}
