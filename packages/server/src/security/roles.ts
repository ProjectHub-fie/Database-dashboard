/**
 * Read-only role detection. The connected PostgreSQL role's actual grants are
 * the source of truth for permissions; this helper only powers UI labeling.
 * Common read-only role names used by Neon and managed providers.
 */
export const readOnlyRoles: ReadonlySet<string> = new Set([
  'readonly',
  'read_only',
  'readonly_user',
  'reviewer',
  'analyst',
  'reporting',
  'rdsreader', // AWS pattern
  'ro',
])

/** Common managed-provider owner/superuser role suffixes (Neon, Supabase, RDS). */
export function describeRole(role: string): { readOnlyHint: boolean; managedOwner: boolean } {
  const lower = role.toLowerCase()
  return {
    readOnlyHint: readOnlyRoles.has(lower),
    managedOwner:
      lower === 'neondb_owner' ||
      lower === 'postgres' ||
      lower === 'root' ||
      (lower === 'supabase_admin'),
  }
}