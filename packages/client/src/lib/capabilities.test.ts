import { describe, it, expect } from 'vitest'
import { capabilitiesOf, canUse } from './capabilities'
import type { ConnectionStatus } from './types'

/**
 * Guards the crash that motivated this helper: a capability payload arriving as
 * an object (a serialized `Set`) or null must degrade to "no capabilities"
 * instead of throwing `includes is not a function` inside a page render.
 */
describe('capabilitiesOf', () => {
  it('returns the ids from a well-formed connection', () => {
    const conn = { connected: true, capabilities: { auth: ['api'], capabilities: ['data.browse', 'sql.execute'] } }
    expect(capabilitiesOf(conn as unknown as ConnectionStatus)).toEqual(['data.browse', 'sql.execute'])
    expect(canUse(conn as unknown as ConnectionStatus, 'sql.execute')).toBe(true)
    expect(canUse(conn as unknown as ConnectionStatus, 'data.import.csv')).toBe(false)
  })

  it('returns an empty list for null, missing or malformed payloads', () => {
    expect(capabilitiesOf(null)).toEqual([])
    expect(capabilitiesOf(undefined)).toEqual([])
    expect(capabilitiesOf({ connected: false } as ConnectionStatus)).toEqual([])
    // Serialized Set / object shape must not throw.
    expect(capabilitiesOf({ capabilities: { capabilities: {} } } as unknown as ConnectionStatus)).toEqual([])
    expect(capabilitiesOf({ capabilities: { capabilities: 'nope' } } as unknown as ConnectionStatus)).toEqual([])
  })

  it('drops non-string entries instead of passing them through', () => {
    const conn = { capabilities: { capabilities: ['data.browse', 42, null] } }
    expect(capabilitiesOf(conn as unknown as ConnectionStatus)).toEqual(['data.browse'])
  })
})
