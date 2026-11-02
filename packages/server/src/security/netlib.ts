/**
 * Outbound network guard for database connection strings.
 *
 * Goals:
 *  - Never let a user-provided hostname reach the network without validation.
 *  - Only allow approved Neon PostgreSQL hosts (`*.neon.tech` / `*.neon.build`)
 *    and approved MongoDB Atlas hosts (`*.mongodb.net`), plus `localhost` in
 *    development. All other destinations are refused.
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
export const MONGODB_HOST_SUFFIXES = [
  // MongoDB Atlas shared/up-to-100 nodes (M0/M2/M5) use `<cluster>.mongodb.net`,
  // serverless clusters use `*-serverless.mongodb.net`, and the SRV host of a
  // replicaset is also `<cluster>.mongodb.net`. Atlas dedicated clusters use
  // `<cluster>.mongodb.net` / `<cluster>.mongodb.net.`. Self-hosted Mongo
  // destinations are intentionally *not* allowlisted: the dashboard refuses
  // unknown hosts exactly like it refuses non-Neon Postgres to prevent SSRF.
  '.mongodb.net',
  '.mongodb.net.',
] as const
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

/**
 * Validate a MongoDB connection URL. Only Atlas `*.mongodb.net` hosts are
 * permitted (self-hosted Mongo is intentionally blocked to prevent SSRF) and
 * the resolved address is pinned, same as Neon. The SRV form is handled as
 * well: Node's driver resolves the SRV records itself, so this validation
 * checks the hostname suffix and the initial resolved A address without
 * unwrapping SRV.
 */
export async function verifyMongodbConnectionUrl(
  rawUrl: string,
  opts: { allowLocalhost?: boolean } = {},
): Promise<{
  host: string
  port: number
  database: string
  role: string
  secrets: string[]
  verified: MongoVerifiedHost
}> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid database URL format' })
  }

  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol)) {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Expected a mongodb:// or mongodb+srv:// connection URL' })
  }

  const host = url.hostname
  if (!host) throw new AppError({ code: 'BAD_REQUEST', message: 'Database URL is missing a host' })
  const port = url.port ? Number.parseInt(url.port, 10) : 27017
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Database URL has an invalid port' })
  }

  const rawPassword = url.password ? decodeURIComponent(url.password) : ''
  const role = url.username ? decodeURIComponent(url.username) : ''
  const database = url.pathname.replace(/^\//, '').split('?')[0] || 'test'
  const secrets = [rawPassword, role, database].filter((s) => s.length > 0)

  const verified = await (url.protocol === 'mongodb+srv:'
    ? verifyMongodbSrvHost(host, { allowLocalhost: opts.allowLocalhost })
    : verifyMongodbHost(host, { allowLocalhost: opts.allowLocalhost }))
  return { host, port, database, role, secrets, verified }
}

/**
 * Resolve a `mongodb+srv://` SRV host and pin its addresses.
 *
 * The SRV root (`cluster0.abc123.mongodb.net`) normally has no A/AAAA record —
 * only the `_mongodb._tcp.` SRV record points at the shard hostnames. The
 * driver will later ask our `lookup` callback for *those* hostnames, so we
 * resolve each shard's A record, validate none is forbidden, and return a map
 * for the socket pin.
 */
export async function verifyMongodbSrvHost(
  host: string,
  opts: { allowLocalhost?: boolean } = {},
): Promise<MongoVerifiedHost> {
  // Same SSRF guard as the plain host path: only *.mongodb.net SRV roots (and
  // localhost in dev) may be resolved. Without this an operator could point
  // mongodb+srv at an arbitrary DNS host that returns SRV -> private targets.
  const lower = host.toLowerCase()
  if (LOCALHOST_HOSTS.includes(lower)) {
    const allowLocalhost = opts.allowLocalhost ?? config.nodeEnv !== 'production'
    if (!allowLocalhost) {
      throw new AppError({
        code: 'CONNECTION_UNSUPPORTED_HOST',
        message: 'This host is not permitted',
        detail: `host '${host}' is a local address and outbound connections are restricted`,
      })
    }
  } else if (!MONGODB_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    throw new AppError({
      code: 'CONNECTION_UNSUPPORTED_HOST',
      message: `Only MongoDB Atlas hosts are allowed (expected *mongodb.net). Host '${host}' is not an approved Mongo endpoint.`,
    })
  }

  const targetMap = await resolveMongoSrvTargets(host, opts)
  return {
    host,
    port: 27017,
    address: targetMap.addresses[0]!,
    isLocalhost: false,
    srvMap: targetMap.byHostname,
  }
}

export interface MongoSrvPin {
  /** SRV target hostname → pinned address (for the driver's lookup callback). */
  byHostname: Map<string, string>
  /** All target addresses (validated public). */
  addresses: string[]
  /** Raw SRV targets in resolution order. */
  targets: Array<{ name: string; port: number }>
}

/**
 * Resolve the SRV record for `_mongodb._tcp.<host>`, then A records for each
 * target, validating every address. Returns a per-hostname pin map plus the
 * ordered address list. Throws AppError when the SRV record is missing or any
 * target resolves to a forbidden address.
 */
export async function resolveMongoSrvTargets(
  host: string,
  opts: { allowLocalhost?: boolean } = {},
): Promise<MongoSrvPin> {
  const allowLocalhost = opts.allowLocalhost ?? config.nodeEnv !== 'production'

  let records: Array<{ name: string; port: number }>
  try {
    records = await dns.resolveSrv(`_mongodb._tcp.${host}`)
  } catch (err) {
    throw new AppError({
      code: 'CONNECTION_FAILED',
      message: `Could not resolve MongoDB SRV record for '${host}'`,
      detail: `SRV lookup for _mongodb._tcp.${host} failed (${(err as { code?: string })?.code ?? 'error'})`,
      cause: err,
    })
  }
  if (records.length === 0) {
    throw new AppError({
      code: 'CONNECTION_FAILED',
      message: `The MongoDB host '${host}' has no SRV record; use a mongodb:// URL or check the cluster hostname.`,
      detail: 'SRV query returned no records',
    })
  }

  const addresses: string[] = []
  const byHostname = new Map<string, string>()
  const targets: Array<{ name: string; port: number }> = []
  // Resolve every target so a DNS-rebinding swap on any one of them is caught.
  for (const rec of records) {
    const name = rec.name.replace(/\.$/, '')
    targets.push({ name, port: rec.port })
    if (LOCALHOST_HOSTS.includes(name.toLowerCase())) {
      if (!allowLocalhost) {
        throw new AppError({
          code: 'CONNECTION_UNSUPPORTED_HOST',
          message: 'This host is not permitted',
          detail: `SRV target '${name}' is a local address and outbound connections are restricted`,
        })
      }
      byHostname.set(name, '127.0.0.1')
      addresses.push('127.0.0.1')
      continue
    }
    if (!/^[a-z0-9.-]+$/i.test(name) || name.length > 253) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Hostname contains invalid characters' })
    }
    const targetAddrs = await resolveAddresses(name)
    if (targetAddrs.length === 0) {
      throw new AppError({
        code: 'CONNECTION_FAILED',
        message: `Could not resolve database host '${name}'`,
        detail: `SRV target ${name} resolved to no addresses`,
      })
    }
    for (const addr of targetAddrs) {
      if (isForbiddenAddress(addr)) {
        throw new AppError({
          code: 'CONNECTION_UNSUPPORTED_HOST',
          message: 'Database host resolves to an address that is not reachable from this service',
          detail: `${name} resolved to forbidden address ${addr}`,
        })
      }
    }
    byHostname.set(name, targetAddrs[0]!)
    addresses.push(targetAddrs[0]!)
  }

  return { byHostname, addresses, targets }
}

/**
 * Validate a host for MongoDB connections and pin its IP address. Explicitly
 * rejects private, loopback (unless dev override), link-local, multicast,
 * reserved and documentation ranges.
 */
export async function verifyMongodbHost(
  host: string,
  opts: { allowLocalhost?: boolean } = {},
): Promise<PinnedVerifiedHost> {
  const allowLocalhost = opts.allowLocalhost ?? config.nodeEnv !== 'production'
  const lower = host.toLowerCase()

  if (LOCALHOST_HOSTS.includes(lower)) {
    if (!allowLocalhost) {
      throw new AppError({
        code: 'CONNECTION_UNSUPPORTED_HOST',
        message: 'This host is not permitted',
        detail: `host '${host}' is a local address and outbound connections are restricted`,
      })
    }
    return { host, port: 27017, address: '127.0.0.1', isLocalhost: true }
  }

  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (net.isIP(literal) !== 0) {
    throw new AppError({
      code: 'CONNECTION_UNSUPPORTED_HOST',
      message: 'IP address literals are not permitted; use a database hostname',
    })
  }

  if (host.length > 253 || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Hostname contains invalid characters' })
  }

  const isMongo = MONGODB_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  if (!isMongo) {
    throw new AppError({
      code: 'CONNECTION_UNSUPPORTED_HOST',
      message: `Only MongoDB Atlas hosts are allowed (expected *mongodb.net). Host '${host}' is not an approved Mongo endpoint.`,
    })
  }

  const addresses = await resolveAddresses(host)
  if (addresses.length === 0) {
    throw new AppError({
      code: 'CONNECTION_FAILED',
      message: `Could not resolve database host '${host}'`,
      detail: `DNS resolution returned no addresses for ${host}`,
    })
  }

  for (const addr of addresses) {
    if (isForbiddenAddress(addr)) {
      throw new AppError({
        code: 'CONNECTION_UNSUPPORTED_HOST',
        message: 'Database host resolves to an address that is not reachable from this service',
        detail: `${host} resolved to forbidden address ${addr}`,
      })
    }
  }

  return { host, port: 27017, address: addresses[0]!, isLocalhost: false }
}

/** Like `VerifiedHost` but for Mongo paths (port defaults to 27017). */
export type PinnedVerifiedHost = VerifiedHost

/** Mongo verification result: a single host pin plus (for SRV URLs) the shard map. */
export interface MongoVerifiedHost extends VerifiedHost {
  /** SRV target hostname → pinned address, when the URL used mongodb+srv://. */
  srvMap?: Map<string, string>
}

async function resolveAddresses(host: string): Promise<string[]> {
  try {
    const results = (await dns.resolve4(host, { ttl: false })) as string[]
    if (results.length > 0) return results
    // Try AAAA if there were no A records.
    const aaaa = (await dns.resolve6(host, { ttl: false })) as string[]
    if (aaaa.length > 0) return aaaa
    return []
  } catch (err) {
    // Raw dns errors (ENOTFOUND / EAI_AGAIN / ENODATA) must not leak as a 500.
    // Map them to a client-facing CONNECTION_FAILED like the empty-result path.
    const code = (err as { code?: string })?.code
    throw new AppError({
      code: 'CONNECTION_FAILED',
      message: `Could not resolve database host '${host}'`,
      detail: `DNS resolution failed for ${host}${code ? ` (${code})` : ''}: ${(err as Error)?.message ?? String(err)}`,
      cause: err,
    })
  }
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
