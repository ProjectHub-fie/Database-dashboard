/**
 * Safe SQL identifier quoting for PostgreSQL.
 *
 * Identifiers are never user-interpolated into SQL without going through one
 * of these helpers. `"` inside an identifier is doubled per SQL standard.
 */
import { AppError } from '../lib/errors.js'

/** Quote a single identifier (e.g. a column or table name). */
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/.test(name)) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: `Invalid database identifier: '${name.length > 40 ? name.slice(0, 40) + '…' : name}'`,
    })
  }
  return `"${name.replace(/"/g, '""')}"`
}

/** Quote a fully-qualified identifier: schema.table -> "schema"."table". */
export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}

/** Quote a possibly-dotted value (schema and/or table). Ensures both parts are validated. */
export function quoteRef(schema: string | undefined, name: string): string {
  if (schema) return quoteQualified(schema, name)
  return quoteIdent(name)
}

/** Validate a database/role/branch/project target name used in API params. */
export function assertSafeResourceName(
  name: string,
  label: string,
  pattern: RegExp,
  maxLen = 64,
): string {
  if (name.length === 0 || name.length > maxLen || !pattern.test(name)) {
    throw new AppError({
      code: 'BAD_REQUEST',
      message: `Invalid ${label}: must match ${pattern.source} (max ${maxLen} chars)`,
    })
  }
  return name
}

export const DATABASE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_$-]*$/
export const ROLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_$-]*$/
export const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/
export const BRANCH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/