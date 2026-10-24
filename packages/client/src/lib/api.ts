import { ApiErrorBody } from './types'
import { requestReauth } from './reauth'

/**
 * Thin fetch wrapper. Credentials travel in HttpOnly cookies; the CSRF token
 * lives in a readable cookie and is echoed back in a header for non-GET
 * requests (double-submit). No secrets are ever stored on the client.
 */

const CSRF_COOKIE = 'dbh_csrf'

/**
 * Optional API origin for split deployments (static frontend on Vercel, API
 * elsewhere). Empty means same-origin, which is the default. This is a public
 * URL only — credentials are never configured client-side.
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

function readCookie(name: string): string | undefined {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : undefined
}

/**
 * Force the server to (re)issue the CSRF cookie.
 *
 * The cookie is minted lazily on any `/api` response, so a browser holding a
 * stale pair — anonymous session expired, or the backend restarted and lost its
 * in-memory store — would otherwise send a token the server no longer knows and
 * get a 403 on its first write. A same-origin GET re-mints it. Concurrent
 * callers share one request.
 */
let csrfBootstrap: Promise<void> | null = null

function ensureCsrfCookie(): Promise<void> {
  if (!csrfBootstrap) {
    csrfBootstrap = fetch(`${API_BASE}/api/auth/me`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        csrfBootstrap = null
      })
  }
  return csrfBootstrap
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string

  constructor(status: number, body: ApiErrorBody | undefined) {
    super(body?.error?.message ?? `Request failed (${status})`)
    this.code = body?.error?.code ?? 'UNKNOWN'
    this.status = status
    this.requestId = body?.requestId
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  timeoutMs?: number
}

async function doRequest<T>(path: string, opts: RequestOptions, csrfRetry = true): Promise<T> {
  const { method = 'GET', query, body, timeoutMs = 60_000 } = opts
  let url = `${API_BASE}${path}`
  if (query) {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) q.set(k, String(v))
    }
    const s = q.toString()
    if (s) url += `?${s}`
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  const isStateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  if (isStateChanging) {
    // No cookie yet (first visit, or a write fired before any API read): ask the
    // server for one instead of sending an empty header and collecting a 403.
    if (!readCookie(CSRF_COOKIE)) await ensureCsrfCookie()
    headers['x-csrf-token'] = readCookie(CSRF_COOKIE) ?? ''
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers,
      // `include` is required for split-origin deployments (static frontend on
      // Vercel, API elsewhere); same-origin requests behave identically.
      credentials: 'include',
      cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const apiError = new ApiError(res.status, (data as ApiErrorBody) ?? undefined)
      // Stale anonymous session (e.g. the backend restarted): re-mint the cookie
      // and retry the same request exactly once. Never retries blindly, so a
      // genuinely rejected write is surfaced unchanged.
      if (csrfRetry && apiError.status === 403 && /csrf/i.test(apiError.message)) {
        await ensureCsrfCookie()
        return doRequest<T>(path, opts, false)
      }
      throw apiError
    }
    return data as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(408, { error: { code: 'TIMEOUT', message: 'The request timed out' } })
    }
    throw new ApiError(0, {
      error: { code: 'NETWORK', message: 'Network error. Check your connection and try again.' },
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch helper with a single transparent retry for NEEDS_REAUTH. When the
 * server rejects a destructive action because the reauth window lapsed, the
 * user confirms their password in the global dialog and the request is retried
 * once. Other errors propagate to the caller unchanged.
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  try {
    return await doRequest<T>(path, opts)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NEEDS_REAUTH') {
      const ok = await requestReauth(err.status === 401 ? err.message : undefined)
      if (ok) return doRequest<T>(path, opts)
    }
    throw err
  }
}

/** Standard CRUD helpers. */
export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'POST', body, query }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'DELETE', body, query }),
}