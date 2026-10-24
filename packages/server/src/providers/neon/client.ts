import {
  Branch,
  ControlPlaneAdapter,
  Database,
  Endpoint,
  Organization,
  Project,
  ProjectConnectionInfo,
  ProviderOperation,
  UsageMetric,
} from '../types.js'
import { AppError } from '../../lib/errors.js'
import { createLogger } from '../../lib/logger.js'
import { redact } from '../../lib/redact.js'

/**
 * Neon API v2 control-plane client. Every request goes through `fetch` to
 * `https://console.neon.tech/api/v2` with a `Bearer` token. The key never
 * leaves the sandbox: mocks replace `fetch` in tests only.
 */
export interface NeonHttpClient {
  request<T>(opts: {
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH'
    path: string
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    apiKey: string
  }): Promise<T>
}

export class NeonApiError extends AppError {
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

const NEON_API_BASE = 'https://console.neon.tech/api/v2'
const NEON_OPERATION_TERMINAL: ReadonlySet<string> = new Set([
  'finished',
  'failed',
  'error',
  'cancelled',
  'skipped',
])

/** Real fetch-based HTTP client. */
export class FetchNeonHttpClient implements NeonHttpClient {
  private readonly logger = createLogger()
  private readonly baseUrl: string

  constructor(baseUrl: string = NEON_API_BASE, private readonly timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async request<T>(opts: {
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH'
    path: string
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    apiKey: string
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
      const res = await fetch(url, {
        method: opts.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      })
      if (res.status === 429 || res.headers.get('retry-after')) {
        throw new NeonApiError({
          message:
            'Neon API rate limit reached. Wait a moment and try again, or use a personal API key with higher limits.',
          providerStatus: res.status,
          detail: 'Neon returned HTTP 429',
          isRateLimit: true,
        })
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let code: string | undefined
        try {
          const j = JSON.parse(text) as { code?: string; message?: string }
          code = j.code
        } catch {
          /* non-JSON error body */
        }
        throw new NeonApiError({
          message: safeNeonErrorMessage(res.status, code),
          providerStatus: res.status,
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
          message: 'The Neon API request timed out',
          detail: 'Neon API request aborted after timeout',
        })
      }
      this.logger.error({ err: e?.message }, 'neon api fetch error')
      throw new AppError({
        code: 'PROVIDER_ERROR',
        message: 'Unexpected error communicating with the Neon API',
        detail: String(e?.message ?? 'unknown'),
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

function safeNeonErrorMessage(status: number, code?: string): string {
  if (status === 401) return 'Invalid Neon API key. Check the key and try again.'
  if (status === 403)
    return 'This Neon key is not authorized for that resource. A project-scoped key may not manage this project or account resources.'
  if (status === 404)
    return 'The requested Neon resource was not found (it may have been deleted).'
  if (status === 409)
    return 'The Neon resource already exists or the operation conflicts with current state.'
  if (status === 422) return 'The request was rejected by Neon (invalid configuration).'
  if (code) return `Neon API rejected the request (${code}).`
  return `Neon API request failed with HTTP ${status}.`
}

const isRunning = (o: ProviderOperation): boolean => !NEON_OPERATION_TERMINAL.has(o.status)

/**
 * Normalizes raw Neon API payloads into internal types. Never exposes the API
 * key or the connection URI password.
 */
export class NeonControlPlane implements ControlPlaneAdapter {
  readonly providerId = 'neon'
  readonly apiBaseUrl = NEON_API_BASE

  constructor(
    private readonly apiKey: string,
    private readonly http: NeonHttpClient = new FetchNeonHttpClient(),
  ) {}

  /**
   * Validate a key against the personal endpoints, falling back to `/projects`.
   *
   * `GET /users/me` is not allowed for organization API keys — Neon answers 404
   * `not allowed for organization API keys` — so treating that failure as an
   * invalid credential rejected every org-scoped key, which is exactly the
   * reduced-blast-radius kind we want people to use. `/projects` is readable by
   * both key types, so it is the real credential test.
   *
   * A 401 still means the key is bad, and is never retried against `/projects`.
   */
  async validateApiKey(): Promise<{
    organizations?: Organization[]
    accountId?: string
    organizationScoped?: boolean
  }> {
    let me: { id?: string } | undefined
    let organizationScoped = false

    try {
      me = await this.http.request<{ id?: string; email?: string }>({
        method: 'GET',
        path: '/users/me',
        apiKey: this.apiKey,
      })
    } catch (err) {
      const status = (err as NeonApiError).providerStatus
      // Organization-scoped keys are refused here but are otherwise valid.
      if (status !== 403 && status !== 404) throw err
      organizationScoped = true
    }

    if (organizationScoped) {
      // Proven by the call below: a response we can read means the key works.
      await this.http.request<{ projects?: unknown[] }>({
        method: 'GET',
        path: '/projects',
        query: { limit: 1 },
        apiKey: this.apiKey,
      })
      return { organizations: [], organizationScoped: true }
    }

    const orgs = await this.http
      .request<{ organizations: NeonOrganization[] }>({
        method: 'GET',
        path: '/users/me/organizations',
        apiKey: this.apiKey,
      })
      .catch(() => ({ organizations: [] as NeonOrganization[] }))
    return { accountId: me?.id, organizations: (orgs.organizations ?? []).map(normalizeOrganization) }
  }

  /** Empty for organization-scoped keys, which cannot read the personal list. */
  async listOrganizations(): Promise<Organization[]> {
    try {
      const { organizations } = await this.http.request<{ organizations: NeonOrganization[] }>({
        method: 'GET',
        path: '/users/me/organizations',
        apiKey: this.apiKey,
      })
      return (organizations ?? []).map(normalizeOrganization)
    } catch (err) {
      const status = (err as NeonApiError).providerStatus
      if (status === 403 || status === 404) return []
      throw err
    }
  }

  async listProjects(orgId?: string): Promise<Project[]> {
    const { projects } = await this.http.request<{ projects: NeonProject[] }>({
      method: 'GET',
      path: '/projects',
      query: orgId ? { org_id: orgId, limit: 200 } : { limit: 200 },
      apiKey: this.apiKey,
    })
    return (projects ?? []).map(normalizeProject)
  }

  async getProject(input: { projectId: string }): Promise<Project> {
    const { project } = await this.http.request<{ project: NeonProject }>({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}`,
      apiKey: this.apiKey,
    })
    return normalizeProject(project)
  }

  async createProject(input: {
    name: string
    orgId?: string
    region?: string
  }): Promise<{ project: Project; operation: ProviderOperation }> {
    const body: Record<string, unknown> = {
      project: {
        name: input.name,
        ...(input.orgId ? { org_id: input.orgId } : {}),
        ...(input.region ? { region_id: input.region } : {}),
      },
    }
    const res = await this.http.request<{ project: NeonProject; operations?: NeonOperation[] }>({
      method: 'POST',
      path: '/projects',
      body,
      apiKey: this.apiKey,
    })
    const operation = normalizeOperation(res.operations?.[0])
    return { project: normalizeProject(res.project), operation }
  }

  async deleteProject(input: { projectId: string }): Promise<{ operation: ProviderOperation }> {
    const res = await this.http.request<{ project?: NeonProject; operations?: NeonOperation[] }>({
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(input.projectId)}`,
      apiKey: this.apiKey,
    })
    const operation = normalizeOperation(res.operations?.[0])
    if (operation.id === '') {
      throw new AppError({
        code: 'PROVIDER_ERROR',
        message: 'Neon did not return a delete operation; nothing can be confirmed as deleted.',
        detail: 'deleteProject response had no operations[]',
      })
    }
    return { operation }
  }

  async listBranches(input: { projectId: string }): Promise<Branch[]> {
    const res = await this.http.request<{ branches: NeonBranch[] }>({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/branches`,
      apiKey: this.apiKey,
    })
    return (res.branches ?? []).map((b) => normalizeBranch(b, input.projectId))
  }

  async createBranch(input: {
    projectId: string
    name?: string
    parentId?: string
  }): Promise<{ branch: Branch; operation: ProviderOperation }> {
    const body: Record<string, unknown> = {
      branch: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.parentId ? { parent_id: input.parentId } : {}),
      },
    }
    const res = await this.http.request<{ branch: NeonBranch; operations?: NeonOperation[] }>({
      method: 'POST',
      path: `/projects/${encodeURIComponent(input.projectId)}/branches`,
      body,
      apiKey: this.apiKey,
    })
    return {
      branch: normalizeBranch(res.branch, input.projectId),
      operation: normalizeOperation(res.operations?.[0]),
    }
  }

  async deleteBranch(input: {
    projectId: string
    branchId: string
  }): Promise<{ operation: ProviderOperation }> {
    const res = await this.http.request<{ branch?: NeonBranch; operations?: NeonOperation[] }>({
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}`,
      apiKey: this.apiKey,
    })
    const operation = normalizeOperation(res.operations?.[0])
    if (operation.id === '') {
      throw new AppError({
        code: 'PROVIDER_ERROR',
        message: 'Neon did not return a delete operation; nothing can be confirmed as deleted.',
        detail: 'deleteBranch response had no operations[]',
      })
    }
    return { operation }
  }

  async listDatabases(input: { projectId: string; branchId: string }): Promise<Database[]> {
    const res = await this.http.request<{ databases: NeonDatabase[] }>({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}/databases`,
      apiKey: this.apiKey,
    })
    return (res.databases ?? []).map((d) => normalizeDatabase(d, input.projectId, input.branchId))
  }

  async createDatabase(input: {
    projectId: string
    branchId: string
    name: string
    owner?: string
  }): Promise<{ database: Database; operation?: ProviderOperation }> {
    const body = {
      database: {
        name: input.name,
        owner_name: input.owner ?? 'neondb_owner',
      },
    }
    const res = await this.http.request<{ database: NeonDatabase; operations?: NeonOperation[] }>({
      method: 'POST',
      path: `/projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}/databases`,
      body,
      apiKey: this.apiKey,
    })
    return {
      database: normalizeDatabase(res.database, input.projectId, input.branchId),
      operation: res.operations?.[0] ? normalizeOperation(res.operations[0]) : undefined,
    }
  }

  async deleteDatabase(input: {
    projectId: string
    branchId: string
    databaseName: string
  }): Promise<{ operation?: ProviderOperation }> {
    const res = await this.http.request<{ database?: NeonDatabase; operations?: NeonOperation[] }>({
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}/databases/${encodeURIComponent(input.databaseName)}`,
      apiKey: this.apiKey,
    })
    const operation = res.operations?.[0] ? normalizeOperation(res.operations[0]) : undefined
    if (operation && operation.id === '') return { operation: undefined }
    return { operation }
  }

  async listEndpoints(input: { projectId: string }): Promise<Endpoint[]> {
    const res = await this.http.request<{ endpoints: NeonEndpoint[] }>({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/endpoints`,
      apiKey: this.apiKey,
    })
    return (res.endpoints ?? []).map((e) => ({
      id: e.id,
      branchId: e.branch_id,
      host: e.host ?? null,
      region: e.region_id,
      state: e.current_state,
      type: e.type,
      raw: e,
    }))
  }

  async getConnectionInfo(input: {
    projectId: string
    databaseName: string
    branchId?: string
    role?: string
  }): Promise<ProjectConnectionInfo> {
    const query: Record<string, string> = { database_name: input.databaseName }
    if (input.branchId) query.branch_id = input.branchId
    if (input.role) query.role_name = input.role
    const res = await this.http.request<{ uri: string }>({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/connection_uri`,
      query,
      apiKey: this.apiKey,
    })
    return parseConnectionUri(res.uri)
  }

  async getOperation(input: { operationId: string; projectId?: string }): Promise<ProviderOperation> {
    if (!input.projectId) {
      throw new AppError({ code: 'BAD_REQUEST', message: 'Operation lookup requires a project id' })
    }
    const res = await this.http.request<{ operation: NeonOperation }>({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/operations/${encodeURIComponent(input.operationId)}`,
      apiKey: this.apiKey,
    })
    return normalizeOperation(res.operation)
  }

  async listOperations(input: { projectId: string; limit?: number }): Promise<ProviderOperation[]> {
    const res = await this.http.request<{ operations: NeonOperation[] }>({
      method: 'GET',
      path: `/projects/${encodeURIComponent(input.projectId)}/operations`,
      query: { limit: input.limit ?? 50 },
      apiKey: this.apiKey,
    })
    return (res.operations ?? [])
      .map(normalizeOperation)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  }

  async waitForOperation(input: {
    operationId: string
    projectId: string
    pollMs?: number
    maxAttempts?: number
  }): Promise<ProviderOperation> {
    const pollMs = input.pollMs ?? 1_000
    const maxAttempts = input.maxAttempts ?? 60
    let op = await this.getOperation(input)
    let attempts = 0
    while (isRunning(op) && attempts < maxAttempts) {
      await sleep(pollMs)
      op = await this.getOperation(input)
      attempts++
    }
    return op
  }

  supportsConsumption = true

  async getConsumption(input: {
    projectId?: string
    branchId?: string
    from: string
    to: string
  }): Promise<UsageMetric[]> {
    const path = input.branchId
      ? '/consumption_history/v2/branches'
      : '/consumption_history/v2/projects'
    const query: Record<string, string> = { from: input.from, to: input.to }
    if (input.projectId) query.project_id = input.projectId
    const res = await this.http
      .request<{
        periods?: Array<{ from?: string; to?: string; metrics?: Array<{ metric?: string; data?: unknown }> }>
      }>({
        method: 'GET',
        path,
        query,
        apiKey: this.apiKey,
      })
      .catch(() => ({ periods: [] }))
    const metrics: UsageMetric[] = []
    for (const period of res.periods ?? []) {
      for (const m of period.metrics ?? []) {
        if (typeof m.metric === 'string' && !m.metric.includes('total')) {
          metrics.push({
            metric: m.metric as UsageMetric['metric'],
            source: 'project',
            interval: `${period.from ?? ''}..${period.to ?? ''}`,
            value: Number(m.data ?? 0),
          })
        }
      }
    }
    return metrics
  }
}

// ---------------------------------------------------------------------------
// Internal Neon API shapes + normalizers
// ---------------------------------------------------------------------------

interface NeonProject {
  id: string
  name?: string
  org_id?: string
  region_id?: string
  platform_id?: string
  created_at?: string
  updated_at?: string
}

interface NeonBranch {
  id: string
  name?: string
  project_id?: string
  primary?: boolean
  default?: boolean
  created_at?: string
  updated_at?: string
}

interface NeonDatabase {
  id: number | string
  name: string
  owner_name?: string
  branch_id?: string
  created_at?: string
  updated_at?: string
}

interface NeonEndpoint {
  id: string
  branch_id: string
  host?: string
  region_id?: string
  current_state: string
  type?: string
}

interface NeonOperation {
  id: string
  project_id?: string
  branch_id?: string
  endpoint_id?: string
  action: string
  status: string
  error?: string
  created_at?: string
  updated_at?: string
  finished_at?: string
}

interface NeonOrganization {
  id: string
  name?: string
}

function normalizeProject(p: NeonProject): Project {
  return {
    id: p.id,
    name: p.name ?? p.id,
    orgId: p.org_id,
    region: p.region_id,
    platformId: p.org_id ? `${p.org_id}/${p.id}` : undefined,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    raw: p,
  }
}

function normalizeBranch(b: NeonBranch, projectId: string): Branch {
  return {
    id: b.id,
    name: b.name ?? b.id,
    projectId: b.project_id ?? projectId,
    primary: Boolean(b.primary ?? b.default),
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    raw: b,
  }
}

function normalizeOrganization(o: NeonOrganization): Organization {
  return { id: o.id, name: o.name ?? o.id }
}

function normalizeDatabase(d: NeonDatabase, projectId: string, branchId: string): Database {
  return {
    id: String(d.id),
    name: d.name,
    owner: d.owner_name,
    projectId: d.branch_id ? projectId : projectId,
    branchId: d.branch_id ?? branchId,
    createdAt: d.created_at,
    raw: d,
  }
}

function normalizeOperation(o?: NeonOperation): ProviderOperation {
  if (!o) {
    return { id: '', action: 'unknown', status: 'finished', raw: undefined }
  }
  const status = (o.status ?? 'running').toLowerCase()
  return {
    id: o.id,
    action: o.action,
    status:
      status === 'cancelling'
        ? 'canceling'
        : status === 'cancelled'
          ? 'canceled'
          : (status as ProviderOperation['status']),
    projectId: o.project_id,
    branchId: o.branch_id,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    finishedAt: o.finished_at ?? (isTerminalStatus(status) ? o.updated_at : undefined),
    error: o.error,
    raw: o,
  }
}

function isTerminalStatus(status: string): boolean {
  return NEON_OPERATION_TERMINAL.has(status)
}

function parseConnectionUri(uri: string): ProjectConnectionInfo {
  try {
    const u = new URL(uri)
    const host = u.hostname
    const port = u.port ? Number.parseInt(u.port, 10) : 5432
    const database = decodeURIComponent(u.pathname.replace(/^\//, '').split('?')[0] ?? '')
    const role = u.username ? decodeURIComponent(u.username) : 'neondb_owner'
    const poolerHost = u.hostname.includes('-pooler.')
      ? undefined
      : u.hostname.replace('.neon.tech', '-pooler.neon.tech')
    return {
      displayName: `${database} @ ${host}`,
      host,
      port,
      database,
      role,
      poolerEnabled: u.hostname.includes('-pooler.'),
      poolerHost,
    }
  } catch {
    throw new AppError({
      code: 'PROVIDER_ERROR',
      message: 'Neon returned an invalid connection URI',
      detail: 'could not parse connection_uri response',
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}