/**
 * Statement classification used to decide whether an operator must explicitly
 * acknowledge a query before it runs.
 *
 * This is a *guard rail*, not the security boundary. Real protection comes
 * from the connected PostgreSQL role's privileges, single-statement execution
 * (the driver always uses the extended protocol, so stacked statements are
 * rejected by PostgreSQL), statement timeouts and audit logging.
 *
 * Classification fails closed: anything not positively recognised as
 * read-only or transaction control is treated as destructive.
 */

export type StatementClass = 'read' | 'transaction' | 'destructive'

const LEADING_COMMENTS = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/

const READ_COMMANDS = new Set(['select', 'show', 'explain', 'describe', 'values', 'table', 'fetch'])
const TX_COMMANDS = new Set([
  'begin',
  'start',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'set',
  'reset',
  'discard',
  'listen',
  'unlisten',
  'notify',
])

/** Keywords that make a `WITH ...` query data-modifying. */
const WRITE_KEYWORDS = /\b(?:insert|update|delete|merge|copy|truncate)\b/i

export function firstKeyword(sql: string): string {
  const stripped = sql.replace(LEADING_COMMENTS, '').trim()
  const match = /^[a-z_]+/i.exec(stripped)
  return match ? match[0].toLowerCase() : ''
}

export function classifyStatement(sql: string): StatementClass {
  const keyword = firstKeyword(sql)
  if (!keyword) return 'destructive'

  if (keyword === 'with') {
    // Data-modifying CTEs (`WITH x AS (DELETE ...) SELECT ...`) are writes.
    return WRITE_KEYWORDS.test(sql.replace(LEADING_COMMENTS, '')) ? 'destructive' : 'read'
  }
  if (READ_COMMANDS.has(keyword)) return 'read'
  if (TX_COMMANDS.has(keyword)) return 'transaction'
  return 'destructive'
}

export function requiresConfirmation(sql: string): boolean {
  return classifyStatement(sql) === 'destructive'
}
