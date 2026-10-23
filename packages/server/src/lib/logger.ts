import pino from 'pino'
import { config } from '../config.js'
import { redactObject } from './redact.js'

/**
 * Structured logger. Use `createScopedLogger(namespace)` for child loggers and
 * always pass known secret values via `secrets` when the message may contain
 * user-supplied data so the redaction pipeline can scrub them.
 */
export function createLogger(opts: { secrets?: () => readonly string[] } = {}) {
  const getSecrets = opts.secrets

  const base = pino({
    level: config.nodeEnv === 'test' ? 'silent' : process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'password', 'passwd', 'apiKey', 'api_key', 'apikey', 'token',
        'accessToken', 'secret', 'authorization', 'connectionString', 'connection_string',
      ],
      censor: '[REDACTED]',
    },
    transport:
      config.nodeEnv === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  })

  function scrub(obj: unknown): Record<string, unknown> {
    if (typeof obj !== 'object' || obj === null) return {}
    const secrets = getSecrets ? getSecrets() : []
    return redactObject(obj, secrets) as Record<string, unknown>
  }

  const emit = (level: 'debug' | 'info' | 'warn' | 'error', obj: unknown, msg?: string) => {
    if (typeof obj === 'string') {
      const m = msg ?? obj
      const extra = typeof obj === 'string' && msg ? { msg: obj } : undefined
      if (extra) base[level](scrub(extra), m)
      else base[level](m)
      return
    }
    if (msg) base[level](scrub(obj), msg)
    else base[level](scrub(obj))
  }

  const logger = {
    child(bindings: Record<string, unknown>) {
      const childBase = base.child(scrub(bindings))
      return {
        debug: (obj: unknown, msg?: string) => {
          if (typeof obj === 'string') { const m = msg ?? obj; const extra = msg ? { msg: obj } : undefined; extra ? childBase.debug(extra, m) : childBase.debug(m) }
          else msg ? childBase.debug(scrub(obj), msg) : childBase.debug(scrub(obj))
        },
        info: (obj: unknown, msg?: string) => {
          if (typeof obj === 'string') { const m = msg ?? obj; const extra = msg ? { msg: obj } : undefined; extra ? childBase.info(extra, m) : childBase.info(m) }
          else msg ? childBase.info(scrub(obj), msg) : childBase.info(scrub(obj))
        },
        warn: (obj: unknown, msg?: string) => {
          if (typeof obj === 'string') { const m = msg ?? obj; const extra = msg ? { msg: obj } : undefined; extra ? childBase.warn(extra, m) : childBase.warn(m) }
          else msg ? childBase.warn(scrub(obj), msg) : childBase.warn(scrub(obj))
        },
        error: (obj: unknown, msg?: string) => {
          if (typeof obj === 'string') { const m = msg ?? obj; const extra = msg ? { msg: obj } : undefined; extra ? childBase.error(extra, m) : childBase.error(m) }
          else msg ? childBase.error(scrub(obj), msg) : childBase.error(scrub(obj))
        },
      }
    },
    debug: (obj: unknown, msg?: string) => emit('debug', obj, msg),
    info: (obj: unknown, msg?: string) => emit('info', obj, msg),
    warn: (obj: unknown, msg?: string) => emit('warn', obj, msg),
    error: (obj: unknown, msg?: string) => emit('error', obj, msg),
  }

  return logger
}

export type AppLogger = ReturnType<typeof createLogger>
export const logger = createLogger()
