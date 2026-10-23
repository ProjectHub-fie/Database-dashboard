/**
 * Secret redaction utilities. Every log message and error surfaced to the
 * browser passes through these helpers so that passwords, connection
 * strings, API keys and auth headers never leak.
 */

const REDACTED = '[REDACTED]'

export interface RedactOptions {
  /** Values that must never appear in the output. */
  secrets?: readonly string[]
  /** If true, strip the raw input entirely. */
  stripBody?: boolean
}

const AUTH_HEADER_RE = /(authorization|proxy-authorization|x-api-key):\s*[^\r\n,]+/gi
const QUERY_PARAM_RE =
  /([?&](?:password|passwd|pwd|api[_-]?key|token|access[_-]?token|secret|apikey|signature|auth))=([^&#]*)/gi
const SQL_CRED_RE =
  /((?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|neon):\/\/)([^:\/@\s]+:[^@\s]*@)/gi

function containsSecret(value: string, secrets: readonly string[] | undefined): boolean {
  if (!secrets || secrets.length === 0 || value.length < 8) return false
  const lower = value.toLowerCase()
  return secrets.some((s) => s.length >= 8 && lower.includes(s.toLowerCase()))
}

/**
 * Redacts sensitive content from an arbitrary value (string, error, object).
 * `secrets` are case-insensitive substring matches for values we know about.
 */
export function redact(value: unknown, options: RedactOptions = {}): string {
  if (value === undefined || value === null) return ''
  const secrets = options.secrets
  const hasSecrets = secrets && secrets.length > 0

  let text: string
  if (typeof value === 'string') {
    text = value
  } else if (value instanceof Error) {
    text = value.message
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (options.stripBody) text = ''

  if (hasSecrets && containsSecret(text, secrets)) {
    text = REDACTED
  }

  text = text.replace(AUTH_HEADER_RE, (_m, head) => `${head}: ${REDACTED}`)
  text = text.replace(QUERY_PARAM_RE, (_m, key) => `${key}=${REDACTED}`)
  text = text.replace(SQL_CRED_RE, (_m, scheme) => `${scheme}${REDACTED}@`)

  return text
}

/**
 * Structured redactor for objects: returns a new object where sensitive keys
 * are replaced and known secret values are masked.
 */
export function redactObject(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v, secrets))
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (LOOKS_SECRET.test(k)) out[k] = REDACTED
      else out[k] = redactObject(v, secrets)
    }
    return out
  }
  if (typeof value === 'string') {
    if (containsSecret(value, secrets) || looksLikeSecret(value)) return REDACTED
    return value
  }
  return value
}

const LOOKS_SECRET = /password|passwd|secret|api[_-]?key|token|authorization|connection/i
const SECRET_VALUE_RE =
  /(^|[&=])(?:api[_-]?key|token|password|secret|signature)($|[&=])|sk-|ghp_|ntoai_|neon_api|postgres(?:ql)?:\/\/|Bearer\s/i

function looksLikeSecret(text: string): boolean {
  if (text.length < 6) return false
  return SECRET_VALUE_RE.test(text)
}

/** Mask a full connection URL to a safe display form. */
export function redactConnectionUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.username) u.username = REDACTED
    if (u.password) u.password = REDACTED
    return u.toString()
  } catch {
    return REDACTED
  }
}