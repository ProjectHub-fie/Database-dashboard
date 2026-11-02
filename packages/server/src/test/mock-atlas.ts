/**
 * Mock MongoDB Atlas HTTP + OAuth clients for tests. Mirrors `mockNeonHttp`:
 * requests are matched against whitelisted handlers, so no request ever
 * reaches the real network and unexpected calls fail loudly.
 */

import { AtlasApiError, AtlasHttpClient, AtlasOauthClient } from '../providers/mongodb-atlas/client.js'

export interface MockAtlasHttpClient extends AtlasHttpClient {
  _requests: Array<{ method: string; path: string; body: unknown }>
  _setHandler(method: string, path: string, handler: (body: unknown, params: Record<string, string>) => unknown): void
}

export function mockAtlasHttp(): MockAtlasHttpClient {
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  const handlers = new Map<string, (body: unknown, params: Record<string, string>) => unknown>()

  return {
    _requests: requests,
    _setHandler(method, path, handler) {
      handlers.set(`${method.toUpperCase()} ${path}`, handler)
    },
    async request<T>(opts: AtlasHttpClient['request'] extends (o: infer O) => unknown ? O : never): Promise<T> {
      requests.push({ method: opts.method.toUpperCase(), path: opts.path, body: opts.body })
      const key = `${opts.method.toUpperCase()} ${opts.path}`
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
          const out = handler(opts.body, params)
          return out as T
        }
      }
      throw new Error(`Unexpected Atlas API request ${opts.method} ${opts.path}`)
    },
  }
}

export interface MockAtlasOauthClient extends AtlasOauthClient {
  _exchanges: Array<{ clientId: string; clientSecret: string }>
  /** Make the next exchange fail as an invalid-credential 401. */
  failNext(): void
}

export function mockAtlasOauth(): MockAtlasOauthClient {
  const exchanges: Array<{ clientId: string; clientSecret: string }> = []
  let failNext = false
  return {
    _exchanges: exchanges,
    failNext() {
      failNext = true
    },
    async exchange(clientId: string, clientSecret: string) {
      exchanges.push({ clientId, clientSecret })
      if (failNext) {
        failNext = false
        throw new AtlasApiError({
          message: 'Invalid MongoDB Atlas service account credentials. Check the client id and secret and try again.',
          providerStatus: 401,
          providerCode: 'invalid_client',
        })
      }
      return { accessToken: 'atlas-test-token', expiresIn: 3600 }
    },
  }
}