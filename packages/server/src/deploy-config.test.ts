import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The SPA is static but the API is a stateful Express service, so Vercel serves
 * the frontend and reverse-proxies `/api/*` to the API host through the
 * `api/[...path]` function. That wiring lives in configuration, not code, and
 * when it breaks the browser sees the platform's HTML 404 instead of the API's
 * JSON envelope — indistinguishable from an application bug. These assertions
 * fail the build if the wiring is loosened.
 */
const repoRoot = path.resolve(__dirname, '../../..')

interface VercelConfig {
  routes?: { src?: string; dest?: string; handle?: string }[]
  buildCommand?: string
  outputDirectory?: string
}

function readVercelConfig(): VercelConfig {
  return JSON.parse(readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8')) as VercelConfig
}

describe('vercel deployment config', () => {
  it('ships the /api proxy function', () => {
    expect(existsSync(path.join(repoRoot, 'api/[...path].ts'))).toBe(true)
  })

  it('routes every /api path to the proxy function', () => {
    const routes = readVercelConfig().routes ?? []
    const apiRoute = routes.find((r) => r.src?.startsWith('^/api'))
    expect(apiRoute, 'no route maps /api to the proxy function').toBeDefined()
    expect(apiRoute?.dest).toBe('/api/[...path]')
  })

  it('lets the API answer for itself instead of the SPA fallback', () => {
    const routes = readVercelConfig().routes ?? []
    const spa = routes.find((r) => r.dest === '/index.html')
    expect(spa?.src).toBeDefined()
    // The negative lookahead must keep rejecting `api/`; otherwise a request to
    // a missing API route returns index.html with a 200 and the client parses
    // HTML as JSON.
    expect(spa?.src).toContain('(?!assets/|api/)')
    const pattern = new RegExp(spa!.src as string)
    expect(pattern.test('/api/connections/url')).toBe(false)
    expect(pattern.test('/overview')).toBe(true)
  })

  it('builds and publishes the client package', () => {
    const config = readVercelConfig()
    expect(config.buildCommand).toContain('-w client')
    expect(config.outputDirectory).toBe('packages/client/dist')
  })

  it('keeps the repo root deployable', () => {
    // `api/` and `vercel.json` are only visible to the build when the Vercel
    // project's Root Directory is the repo root. A different Root Directory is
    // what produces an HTML 404 for every /api call, so assert the layout the
    // root has to contain.
    expect(existsSync(path.join(repoRoot, 'vercel.json'))).toBe(true)
    expect(existsSync(path.join(repoRoot, 'packages/client/package.json'))).toBe(true)
  })
})
