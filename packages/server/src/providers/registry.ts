import { Provider, ProviderCapabilities, ProviderRegistry } from './types.js'
import { AppError } from '../lib/errors.js'

/**
 * Central registry of database providers. New providers call `register()` at
 * startup. The rest of the application only depends on the Provider interface.
 */
export class ProviderRegistryImpl implements ProviderRegistry {
  private readonly providers = new Map<string, Provider<unknown>>()

  register(provider: Provider<unknown>): void {
    if (this.providers.has(provider.info.id)) {
      throw new AppError({ code: 'CONFLICT', message: `Provider '${provider.info.id}' already registered` })
    }
    this.providers.set(provider.info.id, provider)
  }

  get(id: string): Provider<unknown> | undefined {
    return this.providers.get(id)
  }

  require(id: string): Provider<unknown> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new AppError({ code: 'NOT_FOUND', message: `Unknown provider '${id}'` })
    }
    return provider
  }

  list(): Array<Provider<unknown>> {
    return [...this.providers.values()]
  }

  capabilities(id: string): ProviderCapabilities | undefined {
    const provider = this.providers.get(id)
    return provider ? provider.capabilities() : undefined
  }
}

/**
 * Wire form of `ProviderCapabilities`.
 *
 * The registry declares capability ids as a `Set`, which JSON.stringify turns
 * into `{}` — dropping every id and making the browser's `capabilities.includes`
 * throw. Every API response that exposes capabilities must go through this so
 * the client always receives an array.
 */
export function serializeCapabilities(
  caps: ProviderCapabilities | undefined,
): { auth: string[]; capabilities: string[] } {
  if (!caps) return { auth: [], capabilities: [] }
  return { auth: [...caps.auth], capabilities: [...caps.capabilities].sort() }
}

export function createRegistry(): ProviderRegistryImpl {
  return new ProviderRegistryImpl()
}

/**
 * Providers we intend to support, described accurately. Nothing here is
 * registered, connectable, or rendered as working — the UI lists these with
 * `available: false` so an operator can see the roadmap without being able to
 * select a connection mode that would fail.
 *
 * Implement a provider (see docs/PROVIDERS.md), register it in `createRegistry`,
 * and remove its entry here; the UI reads the union of both.
 */
export const PLANNED_PROVIDERS: ReadonlyArray<{
  id: string
  name: string
  kind: 'postgres' | 'mysql' | 'mariadb'
  /** What still has to be built before it can be enabled. */
  blockedBy: string
}> = [
  {
    id: 'postgresql',
    name: 'PostgreSQL (self-hosted)',
    kind: 'postgres',
    blockedBy: 'Needs an admin-controlled host allowlist; arbitrary hosts stay blocked to prevent SSRF.',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    kind: 'postgres',
    blockedBy: 'Shares the PostgreSQL engine adapter; the Supabase management API adapter is not written yet.',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    kind: 'mysql',
    blockedBy: 'Needs a mysql2 adapter (`?` placeholders, backtick quoting) and its own host policy.',
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    kind: 'mariadb',
    blockedBy: 'Same work as MySQL, plus MariaDB-specific catalog differences.',
  },
  {
    id: 'aiven',
    name: 'Aiven',
    kind: 'postgres',
    blockedBy: 'Needs an Aiven control-plane adapter and host policy.',
  },
]

/** For contract tests: a provider must satisfy the full Provider interface. */
export function assertProviderContract(provider: Provider<unknown>): void {
  if (!provider.info || typeof provider.info.id !== 'string') throw new Error('provider.info.id required')
  if (!provider.info.name) throw new Error('provider.info.name required')
  if (!provider.capabilities) throw new Error('provider.capabilities() required')
  if (!provider.connect) throw new Error('provider.connect() required')
  if (!provider.disconnect) throw new Error('provider.disconnect() required')
  if (!provider.createConnectionSession) throw new Error('provider.createConnectionSession() required')
  const caps = provider.capabilities()
  if (!Array.isArray(caps.auth) || caps.auth.length === 0) throw new Error('provider must declare auth methods')
  if (!(caps.capabilities instanceof Set)) throw new Error('provider must declare capabilities set')
  if (caps.auth.includes('connection') && !provider.database) {
    throw new Error('provider declares connection auth but has no database adapter')
  }
  // A provider that supports API auth must be able to mint a control-plane
  // adapter for a specific credential.
  if (caps.auth.includes('api')) {
    const cp = (provider as unknown as { controlPlaneFor?: (key: string) => unknown }).controlPlaneFor
    if (typeof cp !== 'function') {
      throw new Error('provider declares api auth but has no controlPlaneFor(apiKey)')
    }
  }
}