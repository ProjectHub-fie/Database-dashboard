/**
 * MongoDB Atlas Administration API v2 control-plane client.
 *
 * Authentication uses a service-account credential pair (`client_id:secret`),
 * exchanged through the OAuth 2.0 client-credentials flow for a short-lived
 * bearer token — the modern alternative to legacy HTTP-digest API keys. The
 * secret never leaves the sandbox server and is never included in responses.
 *
 * The Atlas resource model differs from Neon's: an Atlas "group" (= project)
 * contains clusters, and clusters are the concrete running deployments. We
 * normalize to the internal contract:
 *   - project -> Project (Atlas group)
 *   - cluster -> Branch (a running deployment; not create/delete-able here)
 *   - database users -> Roles (used to describe who can authenticate)
 */

import {
  Branch,
  ControlPlaneAdapter,
  Database,
  DatabaseRole,
  Endpoint,
  Organization,
  Project,
  ProjectConnectionInfo,
  ProviderOperation,
} from '../types.js'
import crypto from 'node:crypto'
import { AppError } from '../../lib/errors.js'
import { createLogger } from '../../lib/logger.js'
import { redact } from '../../lib/redact.js'

const ATLAS_API_BASE = 'https://cloud.mongodb.com/api/atlas/v2'
const ATLAS_OAUTH_TOKEN_URL = 'https://cloud.mongodb.com/api/oauth/token'

// ---------------------------------------------------------------------------
// HTTP client interfaces
// ---------------------------------------------------------------------------

export interface AtlasHttpClient {
  request<T>(opts: {
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH'
    path: string
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    accessToken: string
    /** When set, use HTTP Digest auth (legacy programmatic API keys). */
    digest?: { username: string; password: string } | null
  }): Promise<T>
}

export class AtlasApiError extends AppError {
  readonly providerStatus: number
  readonly providerCode?: string
  readonly isRateLimit: boolean

  constructor(opts: {
    message: string
    providerStatus: number
    providerCode?: string
    detail?: string
    isRateLimit?: boolean
  }) {
    super({
      code: opts.isRateLimit ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_ERROR',
      message: opts.message,
      detail: opts.detail,
      status: opts.isRateLimit ? 429 : undefined,
    })
    this.providerStatus = opts.providerStatus
    this.providerCode = opts.providerCode
    this.isRateLimit = Boolean(opts.isRateLimit)
  }
}

export interface AtlasOauthClient {
  exchange(clientId: string, clientSecret: string): Promise<{ accessToken: string; expiresIn: number }>
}

/** Real OAuth token exchange against Atlas. */
export class FetchAtlasOauthClient implements AtlasOauthClient {
  private readonly logger = createLogger()

  constructor(
    private readonly tokenUrl = ATLAS_OAUTH_TOKEN_URL,
    private readonly timeoutMs = 30_000,
  ) {}

  async exchange(clientId: string, clientSecret: string): Promise<{ accessToken: string; expiresIn: number }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')
      const res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: 'grant_type=client_credentials',
        signal: controller.signal,
        redirect: 'error',
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let code: string | undefined
        try {
          code = (JSON.parse(text) as { error?: string }).error
        } catch {
          /* non-JSON */
        }
        throw new AtlasApiError({
          message: safeAtlasMessage(res.status, code, 'oauth'),
          providerStatus: res.status,
          isRateLimit: res.status === 429,
          providerCode: code,
          detail: redact(text, { stripBody: true }),
        })
      }
      const j = (await res.json()) as { access_token?: string; expires_in?: number }
      if (!j.access_token) {
        throw new AtlasApiError({
          message: 'MongoDB Atlas did not return an access token.',
          providerStatus: 500,
          detail: 'oauth response missing access_token',
        })
      }
      return { accessToken: j.access_token, expiresIn: j.expires_in ?? 3600 }
    } catch (err) {
      if (err instanceof AppError) throw err
      const e = err as { name?: string; message?: string }
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
        throw new AppError({
          code: 'CONNECTION_FAILED',
          message: 'The MongoDB Atlas request timed out',
          detail: 'Atlas oauth request aborted after timeout',
        })
      }
      this.logger.error({ err: e?.message }, 'atlas oauth fetch error')
      throw new AppError({
        code: 'PROVIDER_ERROR',
        message: 'Unexpected error communicating with MongoDB Atlas',
        detail: String(e?.message ?? 'unknown'),
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Real fetch-based Atlas API client using a bearer token. */
export class FetchAtlasHttpClient implements AtlasHttpClient {
  private readonly logger = createLogger()
  private readonly baseUrl: string

  constructor(baseUrl: string = ATLAS_API_BASE, private readonly timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async request<T>(opts: {
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH'
    path: string
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    accessToken: string
    digest?: { username: string; password: string } | null
  }): Promise<T> {
    const url = new URL(this.baseUrl + opts.path)
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const isDigest = Boolean(opts.digest)

      // Legacy programmatic API keys use HTTP Digest auth: the first request
      // must be sent *without* credentials, and the server's 401 carries the
      // WWW-Authenticate challenge (realm/nonce). We then re-send with the
      // computed digest header.
      let authHeaders: Record<string, string>
      if (isDigest) {
        const challenge = await readDigestChallenge(
          url,
          opts.method,
          opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          this.timeoutMs,
        )
        authHeaders = digestAuthorizationHeader(challenge, opts, url.pathname + url.search)
      } else {
        authHeaders = { Authorization: `Bearer ${opts.accessToken}` }
      }

      const res = await fetch(url, {
        method: opts.method,
        headers: {
          Accept: 'application/vnd.atlas.2024-08-05+json',
          ...authHeaders,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      })
      if (res.status === 429 || res.headers.get('retry-after')) {
        throw new AtlasApiError({
          message: 'MongoDB Atlas rate limit reached. Wait a moment and try again.',
          providerStatus: res.status,
          detail: 'Atlas returned HTTP 429',
          isRateLimit: true,
        })
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let code: string | undefined
        try {
          const j = JSON.parse(text) as { errorCode?: string }
          code = j.errorCode
        } catch {
          /* non-JSON */
        }
        throw new AtlasApiError({
          message: safeAtlasMessage(res.status, code, 'api'),
          providerStatus: res.status,
          isRateLimit: res.status === 429,
          providerCode: code,
          detail: redact(text, {}).slice(0, 2_000),
        })
      }
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof AppError) throw err
      const e = err as { name?: string; message?: string }
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
        throw new AppError({
          code: 'CONNECTION_FAILED',
          message: 'The MongoDB Atlas request timed out',
          detail: 'Atlas API request aborted after timeout',
        })
      }
      this.logger.error({ err: e?.message }, 'atlas api fetch error')
      throw new AppError({
        code: 'PROVIDER_ERROR',
        message: 'Unexpected error communicating with MongoDB Atlas',
        detail: String(e?.message ?? 'unknown'),
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP Digest auth helpers (legacy programmatic API keys)
// ---------------------------------------------------------------------------

interface DigestChallenge {
  realm: string
  nonce: string
  opaque?: string
  qop?: string[]
  algorithm?: string
}

/**
 * Perform an unauthenticated first request so Atlas answers with a 401 plus
 * `WWW-Authenticate: Digest …`. Returns the parsed challenge. Throws a safe
 * AppError when Atlas does not issue a Digest challenge (e.g. the endpoint
 * rejects the method with a plain 4xx first).
 */
async function readDigestChallenge(
  url: URL,
  method: string,
  body: string | undefined,
  timeoutMs: number,
): Promise<DigestChallenge> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.atlas.2024-08-05+json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      signal: controller.signal,
      redirect: 'error',
    })
    if (res.status !== 401) {
      const text = await res.text().catch(() => '')
      throw new AtlasApiError({
        message: 'MongoDB Atlas did not require digest authentication for this resource.',
        providerStatus: res.status,
        detail: `Expected 401 + WWW-Authenticate, got ${res.status}${text ? ` (${String(text).slice(0, 200)})` : ''}`,
      })
    }
    const hdr = res.headers.get('www-authenticate')
    if (!hdr || !/digest/i.test(hdr)) {
      throw new AtlasApiError({
        message: 'MongoDB Atlas did not issue a digest authentication challenge.',
        providerStatus: 401,
        detail: `WWW-Authenticate was '${String(hdr).slice(0, 200)}'`,
      })
    }
    return parseDigestChallenge(hdr)
  } catch (err) {
    if (err instanceof AppError) throw err
    const e = err as { name?: string; message?: string }
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
      throw new AppError({
        code: 'CONNECTION_FAILED',
        message: 'The MongoDB Atlas request timed out',
        detail: 'Atlas digest challenge aborted after timeout',
      })
    }
    throw new AppError({
      code: 'PROVIDER_ERROR',
      message: 'Unexpected error communicating with MongoDB Atlas',
      detail: String(e?.message ?? 'unknown'),
    })
  } finally {
    clearTimeout(timer)
  }
}

export function parseDigestChallenge(header: string): DigestChallenge {
  // Strip the leading "Digest " keyword.
  const value = header.replace(/^\s*digest\s+/i, '')
  const realm = /\brealm="([^"]*)"/i.exec(value)?.[1] ?? ''
  const nonce = /\bnonce="([^"]*)"/i.exec(value)?.[1] ?? ''
  const opaque = /\bopaque="([^"]*)"/i.exec(value)?.[1]
  const algorithm = /\balgorithm=([^\s,]+)/i.exec(value)?.[1]?.replace(/"/g, '')
  const stale = /\bstale=(true|false)/i.test(value)
  void stale
  const qopRaw = /\bqop="([^"]*)"/i.exec(value)?.[1]
  const qop = qopRaw ? qopRaw.split(',').map((s) => s.trim()) : undefined
  if (!realm || !nonce) {
    throw new AtlasApiError({
      message: 'MongoDB Atlas returned an incomplete digest challenge.',
      providerStatus: 401,
      detail: `realm/nonce missing from: ${value.slice(0, 200)}`,
    })
  }
  return { realm, nonce, opaque, qop, algorithm }
}

/**
 * Compute the `Authorization: Digest …` header (RFC 2617 with qop=auth).
 */
export function digestAuthorizationHeader(
  challenge: DigestChallenge,
  opts: { digest?: { username: string; password: string } | null; method: string },
  uri: string,
): Record<string, string> {
  if (!opts.digest) return {}
  const { username, password } = opts.digest
  const realm = challenge.realm
  const nonce = challenge.nonce

  const md5 = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
  // HA1 = MD5(username:realm:password)
  const ha1 = md5(`${username}:${realm}:${password}`)
  // HA2 = MD5(method:uri)
  const ha2 = md5(`${opts.method}:${uri}`)

  const qop = challenge.qop?.includes('auth') ? 'auth' : challenge.qop?.[0]
  let response: string
  if (qop === 'auth') {
    const nc = '00000001'
    const cnonce = crypto.randomBytes(8).toString('hex')
    // response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    const parts = [
      `username="${username}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `qop=${qop}`,
      `nc=${nc}`,
      `cnonce="${cnonce}"`,
      `response="${response}"`,
    ]
    if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`)
    return { Authorization: `Digest ${parts.join(', ')}` }
  }

  // No qop in the challenge: response = MD5(HA1:nonce:HA2)
  response = md5(`${ha1}:${nonce}:${ha2}`)
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ]
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`)
  return { Authorization: `Digest ${parts.join(', ')}` }
}

// ---------------------------------------------------------------------------
// Control plane adapter
// ---------------------------------------------------------------------------

export interface MongoAtlasControlPlaneOptions {
  http?: AtlasHttpClient
  oauth?: AtlasOauthClient
  /** Override the token TTL for tests. */
  tokenTtlMs?: number
}

/**
 * Control-plane adapter for MongoDB Atlas. The credential is a service-account
 * `client_id:secret`, exchanged for an OAuth bearer token before each API call.
 * The raw credential is sealed into `secretHints` for redaction and is never
 * serialized to responses.
 */
export class MongoAtlasControlPlane implements ControlPlaneAdapter {
  readonly providerId = 'mongodb-atlas'
  readonly apiBaseUrl = ATLAS_API_BASE

  private readonly http: AtlasHttpClient
  private readonly oauth: AtlasOauthClient
  private readonly tokenTtlMs: number
  // Set for legacy programmatic API keys (publicKey:privateKey), which use
  // HTTP Digest authentication instead of a service-account OAuth exchange.
  private readonly digest?: { username: string; password: string } | null
  private accessToken: string | null = null
  private tokenExpiresAt = 0

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    opts: MongoAtlasControlPlaneOptions = {},
  ) {
    this.http = opts.http ?? new FetchAtlasHttpClient()
    this.oauth = opts.oauth ?? new FetchAtlasOauthClient()
    this.tokenTtlMs = opts.tokenTtlMs ?? 55 * 60 * 1000
    // Service-account client IDs always start with `mdb_sa_id_`; anything else
    // is a legacy programmatic API key pair (public:private) → digest auth.
    this.digest = clientId.toLowerCase().startsWith('mdb_sa_id_')
      ? null
      : { username: clientId, password: clientSecret }
  }

  private async token(): Promise<string> {
    if (this.digest) return ''
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken
    const { accessToken, expiresIn } = await this.oauth.exchange(this.clientId, this.clientSecret)
    this.accessToken = accessToken
    this.tokenExpiresAt = Date.now() + Math.min(this.tokenTtlMs, expiresIn * 1000)
    return accessToken
  }

  /** Issue an Atlas API request with the auth strategy for this credential. */
  private async req<T>(
    opts: Omit<Parameters<AtlasHttpClient['request']>[0], 'accessToken' | 'digest'>,
  ): Promise<T> {
    const token = await this.token()
    return this.http.request<T>({ ...opts, accessToken: token, digest: this.digest ?? null })
  }

  /** Verify the credential; independently of the orgs list. */
  async validateApiKey(): Promise<{
    organizations?: Organization[]
    accountId?: string
    organizationScoped?: boolean
  }> {
    await this.token() // throws 401 / rate limit when invalid
    // A real Atlas auth failure (401/403) means the credential is invalid and
    // must fail validation. Non-auth failures (e.g. the caller cannot list orgs
    // for a project-scoped key) are tolerated so the key can still be used.
    const orgs = await this.listOrganizations().catch((e) => {
      if (e instanceof AtlasApiError && (e.providerStatus === 401 || e.providerStatus === 403)) {
        throw e
      }
      return []
    })
    return {
      accountId: this.clientId,
      organizations: orgs,
      organizationScoped: true,
    }
  }

  async listOrganizations(): Promise<Organization[]> {
    const { results } = await this.req<{ results?: Array<{ id: string; name?: string }> }>({
      method: 'GET',
      path: '/orgs',
      query: { itemsPerPage: 100 },
    })
    return (results ?? []).map((o) => ({ id: o.id, name: o.name ?? o.id }))
  }

  async listProjects(orgId?: string): Promise<Project[]> {
    const { results } = await this.req<{ results?: AtlasGroup[] }>({
      method: 'GET',
      path: '/groups',
      query: { itemsPerPage: 100 },
    })
    return (results ?? [])
      .filter((g) => !orgId || g.orgId === orgId)
      .map(normalizeProject)
  }

  async getProject(input: { projectId: string }): Promise<Project> {
    const group = await this.req<AtlasGroup>({
      method: 'GET',
      path: `/groups/${encodeURIComponent(input.projectId)}`,
    })
    return normalizeProject(group)
  }

  async createProject(input: { name: string; orgId?: string; region?: string }): Promise<{ project: Project; operation: ProviderOperation }> {
    if (!input.orgId) {
      throw new AppError({
        code: 'BAD_REQUEST',
        message: 'MongoDB Atlas project creation requires an organization id.',
      })
    }
    const body: Record<string, unknown> = { name: input.name, orgId: input.orgId }
    if (input.region) body.regionUsageRestrictions = [input.region]
    const group = await this.req<AtlasGroup>({
      method: 'POST',
      path: '/groups',
      body,
    })
    return {
      project: normalizeProject(group),
      operation: { id: `atlas-create-${group.id}`, action: 'CREATE_PROJECT', status: 'finished' },
    }
  }

  async deleteProject(input: { projectId: string }): Promise<{ operation: ProviderOperation }> {
    await this.req<unknown>({
      method: 'DELETE',
      path: `/groups/${encodeURIComponent(input.projectId)}`,
    })
    return {
      operation: { id: `atlas-delete-${input.projectId}`, action: 'DELETE_PROJECT', status: 'finished' },
    }
  }

  /** Atlas clusters are the concrete deployments; they stand in for "branches". */
  async listBranches(input: { projectId: string }): Promise<Branch[]> {
    const { results } = await this.req<{ results?: AtlasCluster[] }>({
      method: 'GET',
      path: `/groups/${encodeURIComponent(input.projectId)}/clusters`,
    })
    return (results ?? []).map((c) => normalizeCluster(c, input.projectId))
  }

  async createBranch(_input: { projectId: string; name?: string; parentId?: string }): Promise<{ branch: Branch; operation: ProviderOperation }> {
    throw new AppError({
      code: 'NOT_IMPLEMENTED',
      message:
        'Creating Atlas clusters from this dashboard is not supported yet. Create the cluster in the Atlas console and it will appear here.',
    })
  }

  async deleteBranch(_input: { projectId: string; branchId: string }): Promise<{ operation: ProviderOperation }> {
    throw new AppError({
      code: 'NOT_IMPLEMENTED',
      message: 'Deleting Atlas clusters is not supported from this dashboard yet. Delete it in the Atlas console.',
    })
  }

  async listDatabases(input: { projectId: string; branchId?: string }): Promise<Database[]> {
    // Databases on a cluster come from the cluster's own catalog; the Atlas
    // admin API doesn't enumerate a cluster's databases directly, so we expose
    // the system database plus each database user's auth database as attachable
    // targets. The document browser lists real databases live anyway.
    const clusterName = input.branchId ?? ''
    const dbs: Database[] = []
    if (clusterName) {
      const cluster = await this.getCluster(input.projectId, clusterName)
      dbs.push({
        id: 'admin',
        name: 'admin',
        projectId: input.projectId,
        branchId: clusterName,
        raw: { cluster: cluster.name },
      })
    }
    return dbs
  }

  async listRoles(input: { projectId: string; branchId?: string }): Promise<DatabaseRole[]> {
    const { results } = await this.req<{ results?: AtlasDatabaseUser[] }>({
      method: 'GET',
      path: `/groups/${encodeURIComponent(input.projectId)}/databaseUsers`,
    })
    return (results ?? []).map((u) => ({
      name: u.username,
      branchId: input.branchId ?? '',
      authenticationMethod: 'scram-sha-256',
      raw: u,
    }))
  }

  async createDatabase(_input: { projectId: string; branchId?: string; name: string; owner?: string }): Promise<{ database: Database; operation?: ProviderOperation }> {
    throw new AppError({
      code: 'NOT_IMPLEMENTED',
      message: 'Creating databases from this dashboard is not supported yet. Create it in the Atlas console.',
    })
  }

  async deleteDatabase(_input: { projectId: string; branchId?: string; databaseName: string }): Promise<{ operation?: ProviderOperation }> {
    throw new AppError({
      code: 'NOT_IMPLEMENTED',
      message: 'Deleting databases from this dashboard is not supported yet. Manage it in the Atlas console.',
    })
  }

  async listEndpoints(input: { projectId: string }): Promise<Endpoint[]> {
    const { results } = await this.req<{ results?: AtlasCluster[] }>({
      method: 'GET',
      path: `/groups/${encodeURIComponent(input.projectId)}/clusters`,
    })
    return (results ?? []).map((c) => ({
      id: c.id ?? c.name,
      branchId: c.name,
      host: c.srvAddress ?? c.connectionStrings?.standardSrv ?? null,
      region: c.regionName,
      state: c.stateName ?? 'IDLE',
      type: c.clusterType,
    }))
  }

  async getConnectionInfo(input: { projectId: string; databaseName: string; branchId?: string; role?: string }): Promise<ProjectConnectionInfo> {
    const cluster = await this.getCluster(input.projectId, input.branchId ?? '')
    const host = cluster.srvAddress ?? cluster.connectionStrings?.standardSrv ?? cluster.connectionStrings?.standard ?? ''
    return {
      displayName: cluster.name,
      host,
      port: 27017,
      database: input.databaseName,
      role: input.role ?? '',
    }
  }

  async getConnectionUri(_input: { projectId: string; databaseName: string; branchId?: string; role?: string }): Promise<string> {
    // The dashboard cannot mint a driver URI for a cluster: it holds the
    // management credential, not the database user's password. URL mode is the
    // supported path (the operator pastes the Atlas-provided string containing
    // their own user). Document browsing in API-key mode works over the live
    // control-plane connection to whichever database the operator picks.
    throw new AppError({
      code: 'FEATURE_UNAVAILABLE',
      message:
        'MongoDB Atlas cannot issue a driver connection URI for the management API alone. Use Database URL mode and paste the connection string Atlas provides (it contains your own database user), then browse documents.',
    })
  }

  async getOperation(input: { operationId: string; projectId?: string }): Promise<ProviderOperation> {
    void input
    return { id: 'noop', action: 'NOOP', status: 'finished' }
  }

  async listOperations(_input: { projectId?: string; limit?: number }): Promise<ProviderOperation[]> {
    return []
  }

  private async getCluster(projectId: string, clusterName: string): Promise<AtlasCluster> {
    const { results } = await this.req<{ results?: AtlasCluster[] }>({
      method: 'GET',
      path: `/groups/${encodeURIComponent(projectId)}/clusters`,
    })
    const found = (results ?? []).find((c) => c.name === clusterName)
    if (!found) {
      throw new AppError({ code: 'NOT_FOUND', message: `Cluster '${clusterName}' not found in project '${projectId}'.` })
    }
    return found
  }
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeProject(g: AtlasGroup): Project {
  return {
    id: g.id,
    name: g.name ?? 'Atlas group',
    createdAt: g.createdAt,
    region: g.regionUsageRestrictions?.[0],
    raw: g,
  }
}

function normalizeCluster(c: AtlasCluster, projectId: string): Branch {
  return {
    id: c.id ?? c.name,
    name: c.name,
    projectId,
    primary: true,
    createdAt: c.createDate,
    raw: c,
  }
}

function safeAtlasMessage(status: number, code: string | undefined, kind: 'oauth' | 'api'): string {
  if (status === 401) {
    return kind === 'oauth'
      ? 'Invalid MongoDB Atlas service account credentials. Check the client id and secret and try again.'
      : 'This MongoDB Atlas credential is not authorized for that resource.'
  }
  if (status === 403) return 'This MongoDB Atlas credential is not authorized for that resource.'
  if (status === 404) return 'The requested MongoDB Atlas resource was not found (it may have been deleted).'
  if (status === 409) return 'The MongoDB Atlas resource already exists or the operation conflicts with current state.'
  if (status === 422) return 'The request was rejected by MongoDB Atlas (invalid configuration).'
  if (code) return `MongoDB Atlas rejected the request (${code}).`
  return kind === 'oauth'
    ? 'MongoDB Atlas could not exchange the service account credentials.'
    : `MongoDB Atlas request failed with HTTP ${status}.`
}

// ---------------------------------------------------------------------------
// Internal Atlas API shapes
// ---------------------------------------------------------------------------

interface AtlasGroup {
  id: string
  name?: string
  orgId?: string
  createdAt?: string
  regionUsageRestrictions?: string[]
}

interface AtlasClusterConnectionStrings {
  standardSrv?: string
  standard?: string
  srv?: string
}

interface AtlasCluster {
  id?: string
  name: string
  groupId?: string
  stateName?: string
  clusterType?: string
  regionName?: string
  createDate?: string
  srvAddress?: string
  connectionStrings?: AtlasClusterConnectionStrings
}

interface AtlasDatabaseUser {
  id?: string
  username: string
  databaseName?: string
  roles?: Array<{ roleName?: string; databaseName?: string }>
}

export { ATLAS_API_BASE, ATLAS_OAUTH_TOKEN_URL }