import { ZodError } from 'zod'

/**
 * Typed application errors. Each error carries a safe, user-facing message
 * plus an optional internal detail that is only written to server logs, never
 * to browser responses.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFIRMATION_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_UNSUPPORTED_HOST'
  | 'TLS_ERROR'
  | 'QUERY_TIMEOUT'
  | 'QUERY_CANCELLED'
  | 'QUERY_ERROR'
  | 'PERMISSION_DENIED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'VALVE_ERROR'
  | 'EXPORT_ERROR'
  | 'IMPORT_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'NEEDS_REAUTH'
  | 'AUDIT_LOG_DISABLED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  /** Internal-only detail (kept out of browser responses). */
  readonly detail?: string
  /** Values to redact from any log output containing this error. */
  readonly secretValues?: readonly string[]

  constructor(opts: {
    code: ErrorCode
    message: string
    status?: number
    detail?: string
    secretValues?: readonly string[]
    cause?: unknown
  }) {
    super(opts.message)
    this.name = 'AppError'
    this.code = opts.code
    this.status = opts.status ?? statusForCode(opts.code)
    this.detail = opts.detail
    this.secretValues = opts.secretValues
    if (opts.cause !== undefined) this.cause = opts.cause
  }
}

function statusForCode(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'NEEDS_REAUTH':
      return 401
    case 'FORBIDDEN':
    case 'CONFIRMATION_REQUIRED':
      return 403
    case 'NOT_FOUND':
      return 404
    case 'CONFLICT':
      return 409
    case 'RATE_LIMITED':
    case 'PROVIDER_RATE_LIMITED':
      return 429
    case 'PAYLOAD_TOO_LARGE':
      return 413
    case 'NOT_IMPLEMENTED':
      return 501
    case 'BAD_REQUEST':
      return 400
    // Client-driven failures with safe, user-facing messages. These are 4xx;
    // only true server faults (unhandled exceptions, misconfiguration) map to 5xx.
    case 'CONNECTION_FAILED':
    case 'CONNECTION_UNSUPPORTED_HOST':
    case 'TLS_ERROR':
    case 'QUERY_TIMEOUT':
    case 'QUERY_CANCELLED':
    case 'QUERY_ERROR':
    case 'PERMISSION_DENIED':
    case 'PROVIDER_ERROR':
    case 'VALVE_ERROR':
    case 'EXPORT_ERROR':
    case 'IMPORT_ERROR':
    case 'AUDIT_LOG_DISABLED':
      return 400
    default:
      return 500
  }
}

/** All codes that map to HTTP 4xx (used to decide whether to log as warn). */
const CLIENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONFIRMATION_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'NEEDS_REAUTH',
  'PAYLOAD_TOO_LARGE',
  'CONNECTION_FAILED',
  'CONNECTION_UNSUPPORTED_HOST',
  'TLS_ERROR',
  'QUERY_TIMEOUT',
  'QUERY_CANCELLED',
  'QUERY_ERROR',
  'PERMISSION_DENIED',
  'PROVIDER_ERROR',
  'PROVIDER_RATE_LIMITED',
  'VALVE_ERROR',
  'EXPORT_ERROR',
  'IMPORT_ERROR',
  'AUDIT_LOG_DISABLED',
])

export function isClientError(e: unknown): boolean {
  return e instanceof AppError && CLIENT_CODES.has(e.code)
}

export function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e
  // Schema failures are caller mistakes, not server faults: report 400 with the
  // offending field paths instead of a 500 that exposes the schema internals.
  if (e instanceof ZodError) {
    const fields = e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    return new AppError({
      code: 'BAD_REQUEST',
      message: `Invalid request: ${fields.slice(0, 300)}`,
      detail: fields,
      cause: e,
    })
  }
  const message = e instanceof Error ? e.message : 'Unexpected error'
  return new AppError({ code: 'INTERNAL', message: 'Internal server error', detail: message, cause: e })
}

/** Human-oriented labels for the audit log. */
export const ERROR_LABELS: Record<ErrorCode, string> = {
  BAD_REQUEST: 'Bad request',
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  CONFIRMATION_REQUIRED: 'Confirmation required',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  RATE_LIMITED: 'Rate limited',
  CONNECTION_FAILED: 'Connection failed',
  CONNECTION_UNSUPPORTED_HOST: 'Unsupported host',
  TLS_ERROR: 'TLS error',
  QUERY_TIMEOUT: 'Query timed out',
  QUERY_CANCELLED: 'Query cancelled',
  QUERY_ERROR: 'Query error',
  PERMISSION_DENIED: 'Permission denied',
  PROVIDER_ERROR: 'Provider error',
  PROVIDER_RATE_LIMITED: 'Provider rate limited',
  VALVE_ERROR: 'Validation error',
  EXPORT_ERROR: 'Export failed',
  IMPORT_ERROR: 'Import failed',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  NEEDS_REAUTH: 'Reauthentication required',
  AUDIT_LOG_DISABLED: 'Audit log disabled',
  NOT_IMPLEMENTED: 'Not supported',
  INTERNAL: 'Internal error',
}