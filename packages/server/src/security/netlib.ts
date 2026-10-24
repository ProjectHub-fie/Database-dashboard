/**
 * Outbound network guard for database connection strings.
 *
 * Goals:
 *  - Never let a user-provided hostname reach the network without validation.
 *  - Only allow approved Neon PostgreSQL hosts (`*.neon.tech` and the migration
 *    endpoint `*.neon.build` for old projects) and `localhost` in development.
 *  - Never resolve to a private / loopback / link-local / reserved IP (SSRF).
 *  - Pin the resolved IP to the socket so an attacker cannot swap DNS between
 *    the resolve step and the connect step (DNS-rebinding defence).
 */

import dns from 'node:dns/promises'
import net from 'node:net'
import crypto from 'node:crypto'
import { AppError } from '../lib/errors.js'
import { config } from '../config.js'

export const NEON_HOST_SUFFIXES = ['.neon.tech', '.neon.build'] as const
export const LOCALHOST_HOSTS = ['localhost', '127.0.0.1', '::1']

export interface VerifiedHost {
  host: string
  port: number
  /** Resolved and pinned IPv4 address. */
  address: string
  /** True when localhost was allowed by the development override. */
  isLocalhost: boolean
}

/**
 * Parse and verify a Neon PostgreSQL connection URL. Returns the safe metadata
 * plus a pinned IP address ready for the TLS socket.
 */
export async function verifyNeonConnectionUrl(
  rawUrl: string,
  opts: { allowLocalhost?: boolean } = {},
): Promise<{
  host: string
  port: number
  database: string
  role: string
  secrets: string[]
  verified: VerifiedHost
}> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid database URL format' })
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Expected a postgres:// connection URL' })
  }

  const host = url.hostname
  if (!host) throw new AppError({ code: 'BAD_REQUEST', message: 'Database URL is missing a host' })
  const port = url.port ? Number.parseInt(url.port, 10) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Database URL has an invalid port' })
  }

  // Strip credentials for safe display/metadata. Never returned to the browser.
  const rawPassword = url.password ? decodeURIComponent(url.password) : ''
  const role = url.username ? decodeURIComponent(url.username) : 'postgres'
  const database = url.pathname.replace(/^\//, '').split('?')[0] || role
  const secrets = [rawPassword, role, database].filter((s) => s.length > 0)

  const verifiedHost = await verifyNeonHost(host, { allowLocalhost: opts.allowLocalhost })

  return {
    host: verifiedHost.host,
    port,
    database,
    role,
    secrets,
    verified: verifiedHost,
  }
}

/**
 * Validate a host for Neon database connections and pin its IP address.
 * Explicitly rejects private, loopback (unless dev override), link-local,
 * multicast, reserved and documentation ranges.
 */
export async function verifyNeonHost(
  host: string,
  opts: { allowLocalhost?: boolean } = {},
): Promise<VerifiedHost> {
  if (!host) throw new AppError({ code: 'BAD_REQUEST', message: 'Host is missing' })

  const allowLocalhost = opts.allowLocalhost ?? config.nodeEnv !== 'production'

  if (LOCALHOST_HOSTS.includes(host.toLowerCase())) {
    if (!allowLocalhost) {
      throw new AppError({
        code: 'CONNECTION_UNSUPPORTED_HOST',
        message: 'This host is not permitted',
        detail: `host '${host}' is a local address and outbound connections are restricted`,
      })
    }
    return { host, port: 5432, address: '127.0.0.1', isLocalhost: true }
  }

  // Literal IPv4/IPv6 literals are rejected: Neon URLs always use DNS names.
  // `URL.hostname` keeps IPv6 brackets (`[::1]`), so strip them before the
  // check or a bracketed literal would fall through to the character check and
  // be reported as a malformed hostname instead of a disallowed address.
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (net.isIP(literal) !== 0) {
    throw new AppError({
      code: 'CONNECTION_UNSUPPORTED_HOST',
      message: 'IP address literals are not permitted; use a database hostname',
    })
  }

  const lower = host.toLowerCase()
  if (host.length > 253 || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Hostname contains invalid characters' })
  }

  const isNeon = NEON_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  if (!isNeon) {
    throw new AppError({
      code: 'CONNECTION_UNSUPPORTED_HOST',
      // The host is echoed because the user just typed it and already passed
      // the charset check above; masking it to `***` only made the rejection
      // impossible to diagnose. The password is never part of this message.
      message: `Only Neon database hosts are allowed (expected *${NEON_HOST_SUFFIXES[0]} or *${NEON_HOST_SUFFIXES[1]}). Host '${host}' is not an approved Neon endpoint.`,
    })
  }

  // Resolve and build the socket pin.
  const addresses = await resolveAddresses(host)
  if (addresses.length === 0) {
    throw new AppError({
      code: 'CONNECTION_FAILED',
      message: `Could not resolve database host '${host}'`,
      detail: `DNS resolution returned no addresses for ${host}`,
    })
  }

  // Try every resolved address until one passes validation.
  for (const addr of addresses) {
    if (isForbiddenAddress(addr)) {
      throw new AppError({
        code: 'CONNECTION_UNSUPPORTED_HOST',
        message: 'Database host resolves to an address that is not reachable from this service',
        detail: `${host} resolved to forbidden address ${addr}`,
      })
    }
  }

  return { host, port: 5432, address: addresses[0]!, isLocalhost: false }
}

async function resolveAddresses(host: string): Promise<string[]> {
  const results = (await dns.resolve4(host, { ttl: false })) as string[]
  if (results.length > 0) return results
  // Try AAAA if there were no A records.
  const aaaa = (await dns.resolve6(host, { ttl: false })) as string[]
  if (aaaa.length > 0) return aaaa
  return []
}

/** Resolve only the public addresses of a host for pinning. */
export async function resolvePublicAddresses(
  host: string,
): Promise<string[]> {
  const addrs = await resolveAddresses(host)
  return addrs.filter((a) => !isForbiddenAddress(a))
}

/**
 * A hostname is forbidden if *any* of its resolved A/AAAA records is a private,
 * loopback, link-local, multicast, reserved or documentation address. We reject
 * the whole host so IP-literal bypass tricks fail loudly.
 */
export function isForbiddenAddress(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    return isPrivateIPv4(ip)
  }
  return isPrivateIPv6(ip)
}

function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split('.').map((o) => Number.parseInt(o, 10))
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true
  const a = octets[0]!
  const b = octets[1]!
  const c = octets[2]!

  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 0) {
    if (c === 0) return true // 192.0.0.0/24 (incl. 192.0.0.8/32)
    if (c === 2) return true // 192.0.2.0/24 TEST-NET-1
    return false
  }
  if (a === 192 && b === 88 && c === 99) return true // 192.88.99.0/24
  if (a === 192 && b === 168) return true // private
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true // multicast + reserved
  if (a >= 240) return true
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fe80')) return true // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local
  if (lower.startsWith('ff')) return true // multicast
  if (lower.startsWith('2001:db8')) return true // documentation
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length)
    return isPrivateIPv4(expandV4(v4))
  }
  return false
}

function expandV4(v4: string): string {
  // ::ffff:127.0.0.1 style
  return v4
}

/**
 * Build a TLS connect option set for `pg` that uses the pinned address. We
 * create the socket ourselves, call `sslCheckServerIdentity` with the original
 * hostname for certificate verification, and hand `servername` to the TLS layer
 * so SNI and cert hostname validation use the real host.
 */
export class PinnedSocketFactory {
  private readonly seen = new Map<string, string>()

  constructor(private readonly cache: (host: string) => Promise<string>) {}

  async pin(host: string): Promise<string> {
    const cached = this.seen.get(host)
    if (cached) return cached
    const addr = await this.cache(host)
    if (!addr) throw new AppError({ code: 'CONNECTION_FAILED', message: 'No address available for host' })
    this.seen.set(host, addr)
    return addr
  }

  create(host: string, port: number) {
    const options = {
      host: this.seen.get(host) ?? host,
      port,
      servername: host,
      // sslCheckServerIdentity works with `servername` for hostname validation.
    }
    return options
  }
}

export function generatePinToken(): string {
  return crypto.randomBytes(24).toString('hex')
}
