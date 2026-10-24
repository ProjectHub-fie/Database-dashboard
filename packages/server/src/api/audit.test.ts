import { describe, it, expect, beforeAll } from 'vitest'
import type { Express } from 'express'
import supertest from 'supertest'
import { makeTestApp, seedUser, login } from '../test/test-app.js'
import { AuditService } from '../security/audit.js'
import type { Store } from '../storage/store.js'

describe('Audit router', () => {
  let app: Express
  let audit: AuditService
  let store: Store

  beforeAll(async () => {
    const t = await makeTestApp()
    app = t.app
    audit = t.audit
    store = t.store
  })

  it('requires authentication', async () => {
    const res = await supertest(app).get('/api/audit')
    expect(res.status).toBe(401)
  })

  it('returns an empty audit list when disabled', async () => {
    store.setAuditEnabled(false, 30)
    const { username, password } = await seedUser(store, 'audit-disabled', 'pw-123456!')
    const { agent } = await login(app, username, password)
    const res = await agent.get('/api/audit')
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(false)
    expect(res.body.events).toEqual([])
  })

  it('redacts credentials embedded in detail while keeping the useful text', async () => {
    store.setAuditEnabled(true, 30)
    const seedA = await seedUser(store, 'alice-audit', 'pw-123456!')
    const seedB = await seedUser(store, 'bob-audit', 'pw-123456!')

    const loginA = await login(app, seedA.username, seedA.password)
    await login(app, seedB.username, seedB.password)

    // Read the actual user ids assigned by the store (createUser returns them).
    const userA = store.getUserByUsername('alice-audit')
    const userB = store.getUserByUsername('bob-audit')
    const idA = userA?.id ?? 0
    const idB = userB?.id ?? 0
    expect(idA).toBeGreaterThan(0)
    expect(idB).toBeGreaterThan(0)

    // Detail is diagnostic, so it must survive. Credentials inside it must not.
    audit.write({
      userId: idA,
      sessionId: null,
      event: 'sql.exec',
      status: 'ok',
      detail: 'connect postgresql://neondb_owner:super-secret-value-xyz@ep-x.neon.tech/neondb',
    })
    audit.write({ userId: idB, sessionId: null, event: 'sql.exec', status: 'ok', detail: 'bob query detail' })

    const res = await loginA.agent.get('/api/audit')
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
    // All returned rows belong to alice.
    for (const ev of res.body.events as Array<{ userId: number; detail: string | null }>) {
      expect(ev.userId).toBe(idA)
      if (ev.detail) expect(ev.detail).not.toContain('super-secret-value-xyz')
    }
    const sqlEvent = (res.body.events as Array<{ event: string; detail: string | null }>).find(
      (e) => e.event === 'sql.exec',
    )
    // The surrounding context stays readable; only the password is replaced.
    expect(sqlEvent?.detail).toContain('connect')
    expect(sqlEvent?.detail).toContain('neondb')
    expect(res.body.events.length).toBeGreaterThanOrEqual(1)
    expect(res.body.events.some((e: { event: string }) => e.event === 'sql.exec')).toBe(true)
  })

  it('rejects oversized limit', async () => {
    store.setAuditEnabled(true, 30)
    const { username, password } = await seedUser(store, 'audit-limit', 'pw-123456!')
    const { agent } = await login(app, username, password)
    const res = await agent.get('/api/audit?limit=99999')
    expect(res.status).toBe(400)
  })
})