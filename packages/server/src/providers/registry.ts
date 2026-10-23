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

export function createRegistry(): ProviderRegistryImpl {
  return new ProviderRegistryImpl()
}

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