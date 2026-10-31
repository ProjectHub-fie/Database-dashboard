import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Vercel entrypoint for the DB Remote API.
 *
 * The dashboard is a stateful Express service: it holds per-session PostgreSQL
 * pools (`pg`), connection secrets in memory only, and a SQLite store for users,
 * sessions and audit events. None of that survives a serverless lifecycle
 * (read-only filesystem, no shared memory between invocations), so the API runs
 * on a persistent Node host and this function reverse-proxies to it.
 *
 * Proxying rather than pointing the browser at the API origin directly keeps
 * everything first-party: session and CSRF cookies stay SameSite=Lax on the
 * Vercel domain, and no cross-origin credentials or CORS policy is needed.
 *
 * The upstream origin comes from server-side configuration only, never from the
 * request, so this handler cannot be used as an open proxy or SSRF pivot.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

// Matches the server's own upload ceiling with headroom for multipart framing.
const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024

function sendJson(res: ServerResponse, status: number, code: string, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({ error: { code, message } }))
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.byteLength
    if (total > MAX_PROXY_BODY_BYTES) {
      throw Object.assign(new Error('Request body too large'), { code: 'PAYLOAD_TOO_LARGE' })
    }
    chunks.push(buf)
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)
}

/**
 * Connection-level failures. These are raised before the request reaches the
 * upstream application, so replaying a write against a second origin cannot
 * double-apply it. Anything else (socket reset mid-response, timeout) is
 * ambiguous and must never be retried for a non-idempotent method.
 */
const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
])

function isConnectFailure(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code
  return typeof code === 'string' && CONNECT_FAILURE_CODES.has(code)
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * A dead workspace tunnel does not refuse the connection — it accepts it and
 * then never answers, so an unbounded fetch waits until the platform kills the
 * function and the client sees a bare `502 Bad Gateway` (plain text from
 * Vercel, not this handler). Bounding each attempt is what lets the next origin
 * be tried at all.
 */
const UPSTREAM_TIMEOUT_MS = 6000

/** Statuses a fronting proxy emits when the origin is unreachable. */
const GATEWAY_STATUSES = new Set([502, 503, 504])

/**
 * `true` when a gateway status came from infrastructure rather than the API
 * itself. The API always answers with the `{ error: { code, message } }`
 * envelope, so a non-JSON 502 is safe to retry on another origin.
 */
async function isInfrastructureGateway(res: Response): Promise<boolean> {
  if (!GATEWAY_STATUSES.has(res.status)) return false
  const type = res.headers.get('content-type') ?? ''
  return !type.includes('application/json')
}

function parseOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.replace(/\/+$/, '')
  try {
    const u = new URL(trimmed)
    return u.protocol === 'https:' || u.protocol === 'http:' ? trimmed : undefined
  } catch {
    return undefined
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origins = [parseOrigin(process.env.API_ORIGIN), parseOrigin(process.env.API_ORIGIN_FALLBACK)].filter(
    (o): o is string => Boolean(o),
  )
  if (!origins.length) {
    sendJson(
      res,
      503,
      'API_NOT_CONFIGURED',
      'The API origin is not configured. Set API_ORIGIN on this deployment to the DB Remote server URL.',
    )
    return
  }

  // A self-referential origin makes this function call itself; Vercel reports
  // that as a bare 508 loop rather than a fixable error. Detect it here so a
  // misconfiguration produces one actionable response.
  //
  // The self-reference is easy to miss: on the Vercel edge the function's
  // `x-forwarded-host` is the *deployment* host (`<deploy>.vercel.app`), not the
  // public alias the browser used (`dbremote.vercel.app`), so a naive hostname
  // comparison lets an origin that points back at this deployment look "usable"
  // and silently proxy `/api/*` to the SPA fallback (a plain-text 404).
  // Vercel domains (`*.vercel.app`, `.now.sh`, `.vercel.dev`) and loopback
  // addresses can never be the persistent API this function proxies to: the
  // stateful Express service cannot run in a serverless lifecycle. Treat any
  // such origin as a loop regardless of which host this invocation serves.
  const ownHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0]
  const looksServerless = (host: string): boolean => {
    const h = host.toLowerCase()
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h === '0.0.0.0' ||
      h.endsWith('.vercel.app') ||
      h.endsWith('.now.sh') ||
      h.endsWith('.vercel.dev') ||
      h === 'vercel.app'
    )
  }
  const usable = origins.filter((o) => {
    const originHost = new URL(o).hostname.toLowerCase()
    if (originHost === ownHost.toLowerCase()) return false
    if (looksServerless(originHost)) return false
    return true
  })
  if (!usable.length) {
    // Name the rejected host. Without it the operator cannot tell which of a
    // stale localhost value, a loop back to this alias, or a missing variable
    // they are looking at — and every one of those needs a different fix. The
    // hostname is server-side configuration, not a credential, and it is the
    // offending value itself that has to change.
    const rejected = origins.map((o) => new URL(o).host).join(' and ')
    sendJson(
      res,
      503,
      'API_ORIGIN_LOOP',
      `API_ORIGIN is "${rejected}", which is this deployment, a serverless host, or loopback — none of those can serve the persistent DB Remote API. Point API_ORIGIN at the public URL of the host running the Express server (see docs/OPERATIONS.md).`,
    )
    return
  }

  const incoming = req.url ?? '/'

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
    else headers.set(key, value)
  }
  // Vercel terminates TLS, so the upstream must be told the client used HTTPS.
  headers.set('x-forwarded-proto', 'https')
  const clientIp = req.headers['x-real-ip'] ?? req.headers['x-forwarded-for']
  if (typeof clientIp === 'string') headers.set('x-forwarded-for', clientIp)

  let body: Buffer | undefined
  try {
    body = await readBody(req)
  } catch {
    sendJson(res, 413, 'PAYLOAD_TOO_LARGE', 'The uploaded file exceeds the maximum allowed size.')
    return
  }

  const method = req.method ?? 'GET'
  const mayFailover = IDEMPOTENT.has(method)
  let upstreamRes: Response | undefined
  let servedBy: string | undefined
  let lastCode = 'UPSTREAM_UNAVAILABLE'

  for (const [index, origin] of usable.entries()) {
    const isLast = index === usable.length - 1
    const upstream = new URL(incoming.startsWith('/') ? incoming : `/${incoming}`, origin)
    try {
      const attempt = await fetch(upstream, {
        method,
        headers,
        body: body && body.byteLength ? new Uint8Array(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })

      // The origin is reachable but its fronting tunnel is failing. Retrying a
      // read elsewhere is free; a write could not have been applied if the
      // tunnel itself returned the error, so that is safe too.
      if (!isLast && (await isInfrastructureGateway(attempt))) {
        lastCode = 'UPSTREAM_UNAVAILABLE'
        continue
      }

      upstreamRes = attempt
      servedBy = index === 0 ? 'primary' : 'fallback'
      break
    } catch (err) {
      // A write whose connection broke after the request was sent may already
      // have been applied upstream. Replaying it elsewhere risks a duplicate
      // create/delete, so report the failure and let the caller verify state.
      if (!mayFailover && !isConnectFailure(err)) {
        lastCode = 'AMBIGUOUS_UPSTREAM'
        break
      }
      lastCode = isConnectFailure(err) ? 'UPSTREAM_UNAVAILABLE' : 'AMBIGUOUS_UPSTREAM'
    }
  }

  if (!upstreamRes) {
    const message =
      lastCode === 'AMBIGUOUS_UPSTREAM'
        ? 'The database service did not confirm this request. Check the current state before retrying.'
        : 'The database service is unreachable. Try again shortly.'
    sendJson(res, 502, lastCode, message)
    return
  }

  res.statusCode = upstreamRes.status
  if (servedBy) res.setHeader('x-dbh-origin', servedBy)

  upstreamRes.headers.forEach((value, key) => {
    const name = key.toLowerCase()
    if (name === 'set-cookie') return
    if (HOP_BY_HOP.has(name)) return
    // `fetch` decompresses the upstream body but keeps this header. Forwarding
    // it makes the browser try to gunzip bytes that are already plain, so the
    // response is unreadable and the client reports `HTTP 0 · NETWORK`. The
    // body below is buffered decoded, so the encoding no longer applies.
    if (name === 'content-encoding') return
    res.setHeader(key, value)
  })
  const cookies = upstreamRes.headers.getSetCookie?.() ?? []
  if (cookies.length) res.setHeader('set-cookie', cookies)

  const buffer = Buffer.from(await upstreamRes.arrayBuffer())
  res.setHeader('content-length', String(buffer.byteLength))
  res.end(buffer)
}
