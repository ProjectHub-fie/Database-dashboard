import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Express } from 'express'
import { makeTestApp, seedUser, login } from '../test/test-app.js'

/**
 * Contract tests for the two panels that silently lost their results: SQL
 * Studio rendered nothing after a successful query, and CSV import reported
 * nothing after a successful upload.
 *
 * Both are response-shape bugs at the client/server seam, so the assertions
 * here are on the *wire* shape (`{ result: ... }`, not the bare object) rather
 * than on internals. Only DNS and the `pg` client are faked; the route, the
 * query session, the adapter and the response envelope are the real code.
 */
vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: async () => ['18.0.0.1'],
    resolve6: async () => [],
  },
}))

interface FakeResult {
  rows: unknown[]
  fields: Array<{ name: string; dataTypeID?: number }>
  rowCount: number | null
  command: string
}

const seen: Array<{ text: string; values?: unknown[] }> = []

function fakeQuery(arg: unknown): FakeResult {
  const text = typeof arg === 'string' ? arg : String((arg as { text?: string }).text ?? '')
  const values = typeof arg === 'string' ? undefined : (arg as { values?: unknown[] }).values
  seen.push({ text, values })
  const trimmed = text.trim()

  if (/pg_backend_pid/i.test(trimmed)) {
    return { rows: [{ pid: 4242 }], fields: [{ name: 'pid' }], rowCount: 1, command: 'SELECT' }
  }
  if (/^(SET|BEGIN|COMMIT|ROLLBACK)\b/i.test(trimmed)) {
    return { rows: [], fields: [], rowCount: null, command: 'SET' }
  }
  if (/count\(\*\)/i.test(trimmed)) {
    return { rows: [{ total: '2' }], fields: [{ name: 'total' }], rowCount: 1, command: 'SELECT' }
  }
  if (/^\s*select\s+\*\s+from/i.test(trimmed)) {
    return {
      rows: [
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta, "quoted"' },
      ],
      fields: [{ name: 'id', dataTypeID: 23 }, { name: 'name', dataTypeID: 25 }],
      rowCount: 2,
      command: 'SELECT',
    }
  }
  if (/version\(\)/i.test(trimmed)) {
    return {
      rows: [{ version: 'PostgreSQL 16.4 on x86_64-pc-linux-gnu' }],
      fields: [{ name: 'version', dataTypeID: 25 }],
      rowCount: 1,
      command: 'SELECT',
    }
  }
  if (/^insert\b/i.test(trimmed)) {
    return { rows: [], fields: [], rowCount: 2, command: 'INSERT' }
  }
  return { rows: [], fields: [], rowCount: 0, command: 'SELECT' }
}

vi.mock('../adapters/postgres.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/postgres.js')>('../adapters/postgres.js')
  return {
    ...actual,
    buildPgClient: () => ({
      connect: async () => undefined,
      end: async () => undefined,
      query: async (arg: unknown) => fakeQuery(arg),
      on: () => undefined,
      once: () => undefined,
      connection: { stream: () => undefined },
    }),
  }
})

const DB_URL = 'postgresql://neondb_owner:pw-value@ep-contract-1.us-east-2.aws.neon.tech/neondb?sslmode=require'

describe('SQL and data panel contracts', () => {
  let app: Express
  let agent: Awaited<ReturnType<typeof login>>['agent']
  let csrf = ''

  beforeAll(async () => {
    const t = await makeTestApp()
    app = t.app
    const seed = await seedUser(t.store, 'contract-user')
    const session = await login(app, seed.username, seed.password)
    agent = session.agent
    csrf = session.csrfToken
    const connected = await agent.post('/api/connections/url', { providerId: 'neon', connectionString: DB_URL }, csrf)
    expect(connected.status).toBe(200)
  })

  it('returns query results under `result`, with columns and rows', async () => {
    const res = await agent.post('/api/sql/run', { sql: 'SELECT version()' }, csrf)
    expect(res.status).toBe(200)
    // The client reads `res.result`; a flattened payload would render an empty grid.
    expect(res.body.result).toBeTruthy()
    expect(res.body.result.columns.map((c: { name: string }) => c.name)).toEqual(['version'])
    expect(res.body.result.rows).toHaveLength(1)
    expect(res.body.result.rows[0].version).toContain('PostgreSQL')
    expect(res.body.result.rowCount).toBe(1)
  })

  it('reports a statement that returns no columns without pretending it failed', async () => {
    const res = await agent.post('/api/sql/run', { sql: 'INSERT INTO demo (name) VALUES (\'x\')', confirmDestructive: true }, csrf)
    expect(res.status).toBe(200)
    expect(res.body.result.columns).toEqual([])
    expect(res.body.result.rowCount).toBe(2)
  })

  it('returns import counts under `result`', async () => {
    const res = await agent.post(
      '/api/data/import',
      {
        schema: 'public',
        table: 'demo',
        columns: ['name'],
        rows: [['alpha'], ['beta']],
        batchSize: 200,
        transactional: true,
      },
      csrf,
    )
    expect(res.status).toBe(200)
    expect(res.body.result).toMatchObject({ inserted: 2, failed: 0 })
  })

  it('rejects the 10,000-row page size the export used to request', async () => {
    // Documents the bug the export route replaces: /api/data/rows caps limit at
    // 500, so a "10,000 row" export answered 400 BAD_REQUEST and downloaded nothing.
    const res = await agent.get('/api/data/rows?schema=public&table=demo&offset=0&limit=10000')
    expect(res.status).toBe(400)
  })

  it('exports a table as CSV through the server, not a 10,000-row page', async () => {
    const res = await agent.get('/api/data/export?schema=public&table=demo&format=csv')
    expect(res.status).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/csv')
    const raw = res.text
    expect(raw).toContain('id,name')
    expect(raw).toContain('alpha')
    // Values with commas and quotes must survive a round trip.
    expect(raw).toContain('"beta, ""quoted"""')
  })

  it('exports a table as JSON', async () => {
    const res = await agent.get('/api/data/export?schema=public&table=demo&format=json')
    expect(res.status).toBe(200)
    expect(String(res.headers['content-type'])).toContain('application/json')
    // Raw JSON array body; metadata travels in headers (the client reads those).
    expect(String(res.headers['x-export-rows'])).toBe('2')
    expect(String(res.headers['x-export-truncated'])).toBe('false')
    const parsed = JSON.parse(res.text)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: 1, name: 'alpha' })
  })

  it('rejects an export of an identifier that is not a plain name', async () => {
    const res = await agent.get('/api/data/export?schema=public&table=demo;drop%20table%20x&format=csv')
    expect(res.status).toBe(400)
  })
})
