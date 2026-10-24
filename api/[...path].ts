import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Vercel entrypoint for the DB Horizon API.
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

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = process.env.API_ORIGIN?.replace(/\/+$/, '')
  if (!origin) {
    sendJson(
      res,
      503,
      'API_NOT_CONFIGURED',
      'The API origin is not configured. Set API_ORIGIN on this deployment to the DB Horizon server URL.',
    )
    return
  }

  let target: URL
  try {
    target = new URL(origin)
  } catch {
    sendJson(res, 503, 'API_NOT_CONFIGURED', 'API_ORIGIN is not a valid absolute URL.')
    return
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    sendJson(res, 503, 'API_NOT_CONFIGURED', 'API_ORIGIN must be an http(s) URL.')
    return
  }
  // A self-referential API_ORIGIN makes this function call itself; Vercel
  // reports that as a bare 508 loop rather than a fixable error. Detect it
  // here so a misconfiguration produces one actionable response.
  const ownHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0]
  if (target.hostname === ownHost) {
    sendJson(
      res,
      503,
      'API_ORIGIN_LOOP',
      'API_ORIGIN points at this deployment. Set it to the URL of the persistent DB Horizon API server.',
    )
    return
  }

  const incoming = req.url ?? '/'
  const upstream = new URL(incoming.startsWith('/') ? incoming : `/${incoming}`, origin)

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

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: body && body.byteLength ? new Uint8Array(body) : undefined,
      redirect: 'manual',
    })
  } catch {
    sendJson(res, 502, 'UPSTREAM_UNAVAILABLE', 'The database service is unreachable. Try again shortly.')
    return
  }

  res.statusCode = upstreamRes.status

  upstreamRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return
    if (HOP_BY_HOP.has(key.toLowerCase())) return
    res.setHeader(key, value)
  })
  const cookies = upstreamRes.headers.getSetCookie?.() ?? []
  if (cookies.length) res.setHeader('set-cookie', cookies)

  const buffer = Buffer.from(await upstreamRes.arrayBuffer())
  res.setHeader('content-length', String(buffer.byteLength))
  res.end(buffer)
}
