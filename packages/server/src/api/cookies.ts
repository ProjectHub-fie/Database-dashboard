import { Request } from 'express'

export const SESSION_COOKIE_OPTION = 'dbh_sid'
export const CSRF_COOKIE_OPTION = 'dbh_csrf'

export interface AppCookieOptions {
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax' | 'strict' | 'none'
  path: string
  maxAge?: number
}

export function cookieOptions(_req?: Request): AppCookieOptions {
  const production = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure:
      production &&
      (process.env.FORCE_SECURE_COOKIES === 'true' || process.env.TRUST_PROXY === 'true'),
    sameSite: 'lax',
    path: '/',
  }
}