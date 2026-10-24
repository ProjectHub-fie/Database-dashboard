import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AppConfig {
  port: number
  host: string
  nodeEnv: 'development' | 'production' | 'test'
  corsOrigins: string[]
  cookieSecret: string
  sessionTtlMs: number
  idleSessionTtlMs: number
  sessionReauthTtlMs: number
  uploadDir: string
  maxUploadBytes: number
  trustProxy: boolean
  trustProxyHops: number
  dataDir: string
  serveClient: boolean
  /**
   * Whether a dashboard account is required before connecting. Authentication
   * is temporarily optional (default false) while the connection flows are
   * being exercised; set AUTH_REQUIRED=true to restore the full model. Every
   * check behind this flag is still wired — the flag only short-circuits it.
   */
  authRequired: boolean
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt
  return v === '1' || v.toLowerCase() === 'true'
}

function int(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : dflt
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv =
    env.NODE_ENV === 'test'
      ? 'test'
      : env.NODE_ENV === 'production'
        ? 'production'
        : 'development'

  // Import location is packages/server/src (tsx) or packages/server/dist (built).
  const here = path.dirname(fileURLToPath(import.meta.url))
  const serverRoot = path.resolve(here, '..')
  const dataDir = env.DATA_DIR
    ? path.resolve(env.DATA_DIR)
    : path.join(serverRoot, 'data')

  return {
    port: int(env.PORT, 3001),
    host: env.HOST ?? '127.0.0.1',
    nodeEnv,
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cookieSecret: env.COOKIE_SECRET ?? 'dev-insecure-secret-change-me',
    sessionTtlMs: int(env.SESSION_TTL_MS, 8 * 60 * 60 * 1000),
    idleSessionTtlMs: int(env.IDLE_SESSION_TTL_MS, 30 * 60 * 1000),
    sessionReauthTtlMs: int(env.SESSION_REAUTH_TTL_MS, 10 * 60 * 1000),
    uploadDir: env.UPLOAD_DIR
      ? path.resolve(env.UPLOAD_DIR)
      : path.join(dataDir, 'uploads'),
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024),
    trustProxy: bool(env.TRUST_PROXY, false),
    // A hop count, never `true`. `true` would trust the left-most X-Forwarded-For
    // entry, which a client can forge to bypass IP rate limiting.
    trustProxyHops: Math.max(1, int(env.TRUST_PROXY_HOPS, 1)),
    dataDir,
    // Static SPA hosting is on by default in production. The override exists so
    // staging/self-hosted dev boxes can serve the built client from this server.
    serveClient: bool(env.SERVE_CLIENT, nodeEnv === 'production'),
    authRequired: bool(env.AUTH_REQUIRED, false),
  }
}

export const config = loadConfig()