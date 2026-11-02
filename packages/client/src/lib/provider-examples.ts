import { ProviderCatalogEntry } from './types'

/**
 * Engine-specific copy for the connection forms, keyed by provider `kind`.
 *
 * Kept separate so the LoginPage components never bake in a provider's example
 * string. The placeholder is derived from the provider the operator actually
 * selected, so picking MongoDB Atlas never shows Neon's `postgresql://` hint.
 */
export interface ProviderFormExamples {
  /** `connection` auth method → placeholder for the connection string input. */
  connectionUrl: string
  /** `connection` auth method → placeholder for the API key input. */
  apiKey: string
  /** Error shown when the connection string field is submitted empty. */
  emptyUrlError: string
  /** Short subtitle for the Database URL tab. */
  urlSubtitle: string
  /** Accessibility label for the connection string input. */
  urlAriaLabel: string
}

const EXAMPLES: Record<string, ProviderFormExamples> = {
  postgres: {
    connectionUrl:
      'postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require',
    apiKey: 'neon_xxxxxxxxxxxxxxxx',
    emptyUrlError: 'Paste a PostgreSQL connection string first.',
    urlSubtitle: 'Direct PostgreSQL access to exactly one database.',
    urlAriaLabel: 'PostgreSQL connection string',
  },
  mongodb: {
    connectionUrl:
      'mongodb+srv://dbuser:password@cluster0.abc123.mongodb.net/myapp?retryWrites=true',
    apiKey: 'Public API Key:Private API Key',
    emptyUrlError: 'Paste a MongoDB connection string first.',
    urlSubtitle: 'Direct MongoDB access to exactly one database.',
    urlAriaLabel: 'MongoDB connection string',
  },
}

const FALLBACK: ProviderFormExamples = {
  connectionUrl:
    'postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require',
  apiKey: 'neon_xxxxxxxxxxxxxxxx',
  emptyUrlError: 'Paste a database connection string first.',
  urlSubtitle: 'Direct database access to exactly one database.',
  urlAriaLabel: 'Database connection string',
}

/** Example strings for the selected provider (falls back to the Neon example). */
export function providerFormExamples(
  providers: ProviderCatalogEntry[] | null,
  providerId: string,
): ProviderFormExamples {
  const kind = providers?.find((p) => p.id === providerId)?.kind ?? ''
  return EXAMPLES[kind] ?? FALLBACK
}