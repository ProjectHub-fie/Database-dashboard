import type { Request, Response, NextFunction } from 'express'
import { logger } from './logger.js'

/**
 * Lightweight in-memory request log used by the debug console.
 *
 * This is a diagnostics aid, not the audit trail. It captures method, path,
 * status, duration and error code for the most recent requests so a user can
 * see what the API actually did when something misbehaves. Secrets are never
 * written here — query strings are dropped, paths capped at 128 chars, and no
 * body/cookie values are ever kept.
 */
export interface RequestLogEntry {
  ts: number
  method: string
  path: string
  status: number
  ms: number
  errorCode?: string
}

const MAX_ENTRIES = 200

const entries: RequestLogEntry[] = []

export function recordRequest(entry: RequestLogEntry): void {
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

export function recentRequests(limit = 100): RequestLogEntry[] {
  return entries.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)))
}

const SAFE_PATH_MAX = 128

export function requestLogMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const started = Date.now()
    res.on('finish', () => {
      const path = req.originalUrl || req.url || '/'
      // Keep query strings and long URLs out of the ring buffer entirely;
      // query strings can carry secrets (e.g. /api/foo?key=...).
      const withoutQuery = path.split('?')[0] ?? path
      const clean = withoutQuery.length > SAFE_PATH_MAX ? withoutQuery.slice(0, SAFE_PATH_MAX) : withoutQuery
      const err = (res.locals.error as { code?: string } | undefined)?.code
      const entry: RequestLogEntry = {
        ts: started,
        method: req.method,
        path: clean,
        status: res.statusCode,
        ms: Date.now() - started,
        errorCode: res.statusCode >= 400 ? err : undefined,
      }
      recordRequest(entry)
      logger.debug(
        { method: req.method, path: clean, status: res.statusCode, ms: entry.ms },
        'request',
      )
    })
    next()
  }
}