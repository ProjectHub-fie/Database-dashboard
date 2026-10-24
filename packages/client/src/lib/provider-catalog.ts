import { ProviderCatalogEntry } from './types'

/**
 * The provider the server registers today. `POST /api/connections/*` pins
 * `providerId` to this value server-side, so offering it can never send an
 * unsupported id.
 */
export const FALLBACK_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'neon',
    name: 'Neon PostgreSQL',
    kind: 'postgres',
    available: true,
    authMethods: ['connection', 'api'],
    controlPlane: true,
    capabilities: [],
  },
]

export interface CatalogState {
  /** Providers from `GET /api/providers`, or null when the request failed. */
  providers: ProviderCatalogEntry[] | null
  /** Message shown under the selector when the catalog is unavailable. */
  issue: string | null
}

/**
 * Resolve what the connection forms should render.
 *
 * A failed catalog fetch must not blank the selector. Without a fallback the
 * dropdown renders empty and the submit button disables itself, so a deployment
 * whose API is misconfigured looks like it has no providers at all instead of
 * saying what is actually wrong. Returns null only while the first request is
 * still in flight.
 */
export function resolveCatalog({ providers, issue }: CatalogState): ProviderCatalogEntry[] | null {
  if (providers) return providers
  return issue ? FALLBACK_CATALOG : null
}

/** Whether the selected provider supports a given auth method. */
export function supportsAuthMethod(
  catalog: ProviderCatalogEntry[] | null,
  providerId: string,
  method: 'connection' | 'api',
): boolean {
  const entry = catalog?.find((p) => p.id === providerId)
  return entry?.authMethods.includes(method) ?? false
}

/** Message for a catalog failure, distinguishing a misconfigured deployment. */
export function catalogIssueMessage(errorCode: string | undefined): string {
  return errorCode === 'API_NOT_CONFIGURED'
    ? 'This deployment has no API origin configured, so the provider catalog is unavailable. Showing Neon only.'
    : 'Could not load the provider catalog. Showing Neon only.'
}
