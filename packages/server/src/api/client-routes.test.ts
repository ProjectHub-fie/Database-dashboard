import { describe, expect, it, beforeAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Express } from 'express'
import { makeTestApp, TestAgent } from '../test/test-app.js'

/**
 * Guards the seam between the SPA and the API.
 *
 * The client hardcodes `/api/...` paths. If one of them has no matching server
 * route, the user sees a 404 at the exact moment they use that panel — and it
 * looks like a deployment failure rather than a missing route. This test reads
 * every path out of the client source and proves the backend serves it.
 *
 * A path counts as served when at least one HTTP verb answers with something
 * other than 404: `POST /api/schema/tables` exists while `GET` deliberately does
 * not, and either answer proves the route is mounted.
 */
const clientSrc = path.resolve(__dirname, '../../../client/src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Router mount points the client only uses as string prefixes (`'/api/auth/' +
 * 'me'`), never as a request target. They are not routes, so excluding them
 * keeps the assertion honest rather than papering over a real gap.
 */
const PREFIX_ONLY = new Set(['/api/auth'])

function clientApiPaths(): string[] {
  const found = new Set<string>()
  for (const file of walk(clientSrc)) {
    const source = readFileSync(file, 'utf8')
    // `${...}` interpolations may themselves contain `/` (e.g.
    // `${encodeURIComponent(projectId)}`), so they are consumed as a unit
    // before being replaced. A character class that stops at `$` silently
    // truncated every interpolated path to its static prefix, which meant this
    // test never checked the routes the client actually calls most often.
    for (const match of source.matchAll(/['"`](\/api\/(?:[A-Za-z0-9/_.:-]|\$\{[^}]*\})*)/g)) {
      // Route params are opaque to this test; any non-empty value matches the
      // same route shape.
      found.add(match[1]!.replace(/\$\{[^}]*\}/g, 'sample').replace(/\/$/, ''))
    }
  }
  return [...found].filter((p) => !PREFIX_ONLY.has(p)).sort()
}

describe('client API paths are all served', () => {
  let app: Express
  let agent: TestAgent
  let csrf = ''

  beforeAll(async () => {
    const t = await makeTestApp({ authRequired: false })
    app = t.app
    agent = new TestAgent(app)
    await agent.get('/api/auth/me')
    const raw = agent.cookies.find((c) => c.startsWith('dbh_csrf=')) ?? ''
    csrf = decodeURIComponent(raw.slice('dbh_csrf='.length))
  })

  it('discovered a meaningful number of paths', () => {
    // Sanity-check the extractor: a broken regex would make the suite pass by
    // testing nothing at all.
    expect(clientApiPaths().length).toBeGreaterThan(20)
  })

  it('serves every path the client calls', async () => {
    const missing: string[] = []
    for (const apiPath of clientApiPaths()) {
      const statuses: number[] = []
      statuses.push((await agent.get(apiPath)).status)
      statuses.push((await agent.post(apiPath, {}, csrf)).status)
      statuses.push((await agent.put(apiPath, {}, csrf)).status)
      statuses.push((await agent.delete(apiPath, csrf)).status)
      if (statuses.every((s) => s === 404)) missing.push(`${apiPath} (${statuses.join('/')})`)
    }
    expect(missing, 'client calls routes the API does not serve').toEqual([])
  })
})
