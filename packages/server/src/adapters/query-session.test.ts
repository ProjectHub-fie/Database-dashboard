import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgQuerySession } from './query-session.js'
import type { PgConn } from './postgres.js'

/**
 * `readOnly` decides whether the API refuses writes. It is derived from the
 * connected role's name, never from the request, so a UI that hides the insert
 * button and an API that rejects the insert have to agree.
 *
 * These tests call the real `PgQuerySession` with a fake `pg` client: no socket
 * is opened, and the guard under test is the actual code path.
 */

function fakeConn(role: string): PgConn {
  return {
    client: { query: async () => ({ rows: [{ pid: 1 }], fields: [] }) } as unknown as PgConn['client'],
    role,
    database: 'neondb',
    pinnedAddress: '18.0.0.1',
    clientOptions: {
      host: 'ep-x.us-east-2.aws.neon.tech',
      port: 5432,
      database: 'neondb',
      user: role,
      password: 'x',
      ssl: undefined,
      stream: undefined,
      connectionTimeoutMillis: 5000,
      applicationName: 'db-remote',
    },
  }
}

function makeSession(role: string) {
  const adapter = {
    insertRow: vi.fn(async () => ({ rows: [], fields: [], command: 'INSERT', rowCount: 1 })),
    updateRow: vi.fn(async () => ({ rows: [], fields: [], command: 'UPDATE', rowCount: 1 })),
    deleteRow: vi.fn(async () => ({ rows: [], fields: [], command: 'DELETE', rowCount: 1 })),
  }
  const session = new PgQuerySession(fakeConn(role), adapter as never, {
    buildCancellationConnection: () => ({ end: async () => undefined }) as never,
  })
  return { session, adapter }
}

describe('PgQuerySession read-only enforcement', () => {
  beforeEach(() => vi.clearAllMocks())

  it('treats an owner role as writable', async () => {
    const { session, adapter } = makeSession('neondb_owner')
    expect(session.readOnly).toBe(false)
    await session.insertRow({ schema: 'public', table: 't', row: { a: 1 } })
    expect(adapter.insertRow).toHaveBeenCalledTimes(1)
  })

  /**
   * The bug this pins: the guard compared against the single literal
   * 'readonly', while connections-router labelled the session read-only using
   * the shared `readOnlyRoles` set. A role like `readonly_user` therefore got a
   * read-only badge in the UI but was still allowed to write through the API.
   */
  it.each(['readonly', 'readonly_user', 'ro', 'analyst', 'reporting'])(
    'refuses writes for the read-only role %s, matching the UI label',
    (role) => {
      const { session, adapter } = makeSession(role)
      expect(session.readOnly).toBe(true)

      // The guard throws synchronously (the methods are not `async`), so it is
      // captured directly rather than as a rejected promise.
      const refusal = (fn: () => unknown) => {
        try {
          fn()
          return null
        } catch (err) {
          return err as { code?: string }
        }
      }

      expect(refusal(() => session.insertRow({ schema: 'public', table: 't', row: { a: 1 } }))?.code).toBe('FORBIDDEN')
      expect(
        refusal(() =>
          session.updateRow({ schema: 'public', table: 't', identity: { id: 1 }, identityColumns: ['id'], changes: { a: 2 } }),
        )?.code,
      ).toBe('FORBIDDEN')
      expect(
        refusal(() => session.deleteRow({ schema: 'public', table: 't', identity: { id: 1 }, identityColumns: ['id'] }))?.code,
      ).toBe('FORBIDDEN')

      // Nothing reached the adapter: the refusal is real, not cosmetic.
      expect(adapter.insertRow).not.toHaveBeenCalled()
      expect(adapter.updateRow).not.toHaveBeenCalled()
      expect(adapter.deleteRow).not.toHaveBeenCalled()
    },
  )

  it('matches role names case-insensitively', () => {
    // Postgres folds unquoted identifiers, but a quoted role can be mixed case.
    const { session } = makeSession('READONLY')
    expect(session.readOnly).toBe(true)
  })

  it('treats an unknown role as writable and lets the database decide', () => {
    // The guard is a convenience; PostgreSQL privileges are the real boundary.
    const { session } = makeSession('app_writer')
    expect(session.readOnly).toBe(false)
  })
})
