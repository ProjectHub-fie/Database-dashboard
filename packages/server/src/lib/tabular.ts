/**
 * Tabular serialization for file exports.
 *
 * CSV follows RFC 4180: a field is quoted only when it contains a comma, a
 * quote, a CR or an LF, and embedded quotes are doubled. That matters because
 * `pg` returns text columns verbatim — a single free-text column with a comma
 * in it used to shift every following column one to the right in the exported
 * file, and a newline produced an extra row.
 */

/** A `bytea` column arrives as a Buffer; render it the way psql does. */
function toHex(value: Uint8Array): string {
  return `\\x${Buffer.from(value).toString('hex')}`
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let raw: string
  if (value instanceof Uint8Array) {
    raw = toHex(value)
  } else if (value instanceof Date) {
    raw = value.toISOString()
  } else if (typeof value === 'object') {
    // jsonb, arrays and composite types come back as JS objects; JSON keeps
    // them lossless and readable instead of "[object Object]".
    raw = JSON.stringify(value)
  } else {
    raw = String(value)
  }
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

export function csvHeader(columns: readonly string[]): string {
  return columns.map(csvCell).join(',')
}

export function csvRow(columns: readonly string[], row: Record<string, unknown>): string {
  return columns.map((c) => csvCell(row[c])).join(',')
}

/** JSON-safe representation: Buffers and Dates become strings. */
export function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Uint8Array) return toHex(value)
  if (value instanceof Date) return value.toISOString()
  return value
}

/** Filenames must survive `Content-Disposition` without quoting tricks. */
export function exportFilename(schema: string, table: string, format: 'csv' | 'json'): string {
  const safe = `${schema}.${table}`.replace(/[^A-Za-z0-9_.-]/g, '_')
  return `${safe}.${format}`
}
