import type { ConnectionStatus } from './types'

/**
 * Capability ids for a connection, always as an array.
 *
 * The server contract says `string[]`, but a shape regression there must not
 * crash a page: an object, a serialized `Set` (`{}`) or null all collapse to an
 * empty list, which every page already treats as "feature unavailable".
 */
export function capabilitiesOf(connection: ConnectionStatus | null | undefined): string[] {
  const caps = connection?.capabilities?.capabilities
  return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : []
}

export function canUse(connection: ConnectionStatus | null | undefined, capability: string): boolean {
  return capabilitiesOf(connection).includes(capability)
}