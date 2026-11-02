/**
 * Parse a MongoDB connection URL into connection metadata. The mongodb driver
 * does this internally, but the dashboard needs the parsed parts (host, db,
 * user) for safe metadata and redaction — the driver object isn't enough, and
 * the raw URL must never reach the browser.
 */

import { AppError } from '../lib/errors.js'

export interface ParsedMongoUri {
  /** Original hostname (used for TLS servername). */
  host: string
  /** Port from the URL, or 27017. */
  port: number
  /** Database name from the path (default 'test'). */
  database: string
  /** Username (empty when none in the URL). */
  role: string
  /** Password (empty when none). */
  password: string
}

export function parseMongoUri(rawUrl: string): ParsedMongoUri {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AppError({ code: 'BAD_REQUEST', message: 'Invalid MongoDB connection URL' })
  }
  const host = url.hostname
  const port = url.port ? Number.parseInt(url.port, 10) : 27017
  const database = (url.pathname || '/test').replace(/^\//, '').split('?')[0] || 'test'
  const role = url.username ? decodeURIComponent(url.username) : ''
  const password = url.password ? decodeURIComponent(url.password) : ''
  return { host, port, database, role, password }
}