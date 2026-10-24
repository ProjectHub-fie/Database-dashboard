import { describe, expect, it, vi, afterEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Guards the Vercel reverse proxy (`/api/[...path].ts`). A self-referential
 * API_ORIGIN used to make the function call itself until Vercel answered 508
 * INFINITE_LOOP_DETECTED, which hides the real misconfiguration.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

async function loadHandler(): Promise<Handler> {
  const mod = (await import('../../../../api/[...path].ts')) as { default: Handler }
  return mod.default
}

function makeRes() {
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(chunk?: string) {
      if (chunk) body += chunk
    },
  }
  return { res: res as unknown as ServerResponse, headers, body: () => body }
}

function makeReq(headers: Record<string, string>, url = '/api/providers'): IncomingMessage {
  return { method: 'GET', url, headers } as unknown as IncomingMessage
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('vercel api proxy', () => {
  it('rejects an API_ORIGIN that points at the deployment itself', async () => {
    vi.stubEnv('API_ORIGIN', 'https://dbremote.vercel.app')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handler = await loadHandler()
    const { res, body } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(body()).error.code).toBe('API_ORIGIN_LOOP')
    // The loop must be stopped before any outbound request is attempted.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ignores the port when comparing the deployment host', async () => {
    vi.stubEnv('API_ORIGIN', 'http://127.0.0.1:3001')
    const handler = await loadHandler()
    const { res, body } = makeRes()

    await handler(makeReq({ host: '127.0.0.1:3001' }), res)

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(body()).error.code).toBe('API_ORIGIN_LOOP')
  })

  it('still proxies to a distinct upstream origin', async () => {
    vi.stubEnv('API_ORIGIN', 'https://api.example.com')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const handler = await loadHandler()
    const { res } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
  })
})