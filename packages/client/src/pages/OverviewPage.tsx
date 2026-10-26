import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useOnReconnect } from '../contexts/NetworkContext'
import { api, ApiError } from '../lib/api'
import { DatabaseStats } from '../lib/types'
import { Card, Skeleton, Badge, Button, EmptyState } from '../components/ui'
import { SkeletonList } from '../components/loaders/Skeletons'
import { InlineLoader } from '../components/loaders/PageLoader'
import {
  Activity,
  Database,
  Table2,
  Boxes,
  PlugZap,
  Timer,
  AlertTriangle,
  RefreshCw,
  Server,
  ExternalLink,
} from 'lucide-react'

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(1)} ${units[i]}`
}

export function OverviewPage() {
  const auth = useAuth()
  const c = auth.connection
  const accountOnly = c?.accountOnly === true
  const [stats, setStats] = useState<DatabaseStats | null>(null)
  const [latency, setLatency] = useState<{ ms: number; version: string } | null>(null)
  // The stats request fires on mount, so starting `false` rendered a card full
  // of em dashes for one paint before flipping to the skeleton.
  const [statsLoading, setStatsLoading] = useState(!accountOnly)
  const [statsError, setStatsError] = useState<string | null>(null)
  // Auto-refresh every 30s must not blank the panels it re-fetches, so the
  // skeleton is only for the initial load (no data yet).
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [history, setHistory] = useState<Array<{ id: string; sql: string; durationMs: number; rowCount: number | null; error: string | null; createdAt: number }>>([])
  const [historyLoading, setHistoryLoading] = useState(!accountOnly)

  const load = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const [s, lat] = await Promise.all([
        api.get<{ stats: DatabaseStats }>('/api/data/stats').catch((e: unknown) => {
          if (e instanceof ApiError) {
            if (e.code === 'UNAUTHORIZED' || e.code === 'FORBIDDEN') return null // requires db mode
            throw e
          }
          throw e
        }),
        api.get<{ latencyMs: number; version: string }>('/api/connections/health').catch(() => null),
      ])
      if (s) setStats(s.stats)
      else setStats(null)
      if (lat) setLatency({ ms: lat.latencyMs, version: lat.version })
    } catch (err) {
      setStatsError(err instanceof ApiError ? err.message : 'Could not load database stats')
    } finally {
      setStatsLoading(false)
      setLoadedOnce(true)
    }
  }, [])

  useEffect(() => {
    if (accountOnly) return
    void load()
    const id = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(id)
  }, [load, accountOnly])

  useOnReconnect(() => void load())

  useEffect(() => {
    if (accountOnly) return
    api
      .get<{ history: Array<{ id: string; sql: string; durationMs: number; rowCount: number | null; error: string | null; createdAt: number }> }>(
        '/api/sql/history',
        { limit: 8 },
      )
      .then((res) => setHistory(res.history))
      .catch(() => undefined)
      .finally(() => setHistoryLoading(false))
  }, [accountOnly])

  if (accountOnly) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Header refreshing={false} />
        <Card className="p-6">
          <div className="flex flex-col items-start gap-3">
            <div className="flex items-center gap-2">
              <ExternalLink className="h-5 w-5 text-indigo-500" />
              <h2 className="font-semibold text-slate-900 dark:text-slate-100">Neon account connected (API mode)</h2>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              You are connected to the Neon control plane. Database metrics and SQL tools require a database URL connection —
              switch on the connection screen to measure latency, browse rows, or run queries.
            </p>
            <Badge tone="sky">management · control plane</Badge>
          </div>
        </Card>
        <ConnectionCard />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Header refreshing={statsLoading && loadedOnce} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Connection latency" value={latency ? `${latency.ms} ms` : null} icon={<Timer className="h-4 w-4" />} loading={statsLoading && !loadedOnce} />
        <StatCard label="Database size" value={stats ? formatBytes(stats.sizeBytes) : null} icon={<Database className="h-4 w-4" />} loading={statsLoading && !loadedOnce} />
        <StatCard label="Tables / schemas" value={stats ? `${stats.tableCount} / ${stats.schemaCount}` : null} icon={<Table2 className="h-4 w-4" />} loading={statsLoading && !loadedOnce} />
        <StatCard label="Indexes" value={stats ? String(stats.indexCount) : null} icon={<Boxes className="h-4 w-4" />} loading={statsLoading && !loadedOnce} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <Activity className="h-4 w-4 text-emerald-500" /> Active connections
            </h2>
            <span className="text-xs text-slate-400">{stats ? stats.connectionCount : '—'} total</span>
          </div>
          {statsLoading && !loadedOnce ? (
            <SkeletonList rows={3} />
          ) : statsError ? (
            <PermissionNote text={statsError} />
          ) : stats && stats.activeConnections.length > 0 ? (
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {stats.activeConnections.map((a) => (
                <div key={a.pid} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/50">
                  <PlugZap className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="font-mono text-slate-700 dark:text-slate-200">{a.pid}</span>
                  <span className="text-slate-500 dark:text-slate-400">{a.user} · {a.database}</span>
                  <span className="ml-auto text-slate-400">{a.state ?? '—'}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<PlugZap className="h-8 w-8" />} title="No active connections" description="Connections from this dashboard and others will appear here if your role can see them." />
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <Timer className="h-4 w-4 text-indigo-500" /> Recent queries
            </h2>
            <span className="text-xs text-slate-400">{history.length === 0 ? 'no history yet' : `${history.length} in session`}</span>
          </div>
          {historyLoading ? (
            <SkeletonList rows={4} />
          ) : history.length === 0 ? (
            <EmptyState icon={<Timer className="h-8 w-8" />} title="No queries in this session" description="Run a query in SQL Studio and it will show up here with its execution time." />
          ) : (
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {history.slice(0, 6).map((h) => (
                <div key={h.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/50">
                  <code className="flex-1 truncate font-mono text-slate-600 dark:text-slate-300">{h.sql.slice(0, 80)}</code>
                  <span className={h.error ? 'text-rose-500' : 'text-slate-400'}>{h.error ? 'error' : `${h.durationMs} ms`}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <ConnectionCard />

      {statsError && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Some metrics are unavailable: {statsError}. This is usually a missing permission on the connected role — the dashboard never fabricates stats.</span>
        </div>
      )}
    </div>
  )
}

function Header({ refreshing }: { refreshing: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Overview</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Connection status and live database health for the currently selected resource.
        </p>
      </div>
      <RefreshSoon refreshing={refreshing} />
    </div>
  )
}

function RefreshSoon({ refreshing }: { refreshing: boolean }) {
  // Background refresh is silent by design: the numbers stay on screen and a
  // small spinner says "re-checking", instead of the panels blinking.
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400" aria-live="polite">
      {refreshing ? (
        <>
          <InlineLoader label="Refreshing database health" />
          <span>refreshing…</span>
        </>
      ) : (
        <>
          <RefreshCw className="h-3.5 w-3.5" /> auto-refresh 30s
        </>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  icon,
  loading,
}: {
  label: string
  value: string | null
  icon: React.ReactNode
  loading?: boolean
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
        {icon}
        {label}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-6 w-20" />
      ) : value ? (
        <div className="mt-2 text-xl font-semibold text-slate-900 dark:text-slate-100">{value}</div>
      ) : (
        <div className="mt-2 text-xl font-semibold text-slate-300 dark:text-slate-600">—</div>
      )}
    </Card>
  )
}

function PermissionNote({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {text}
    </div>
  )
}

function ConnectionCard() {
  const auth = useAuth()
  const c = auth.connection
  if (!c?.connected) {
    return (
      <Card className="p-5">
        <EmptyState
          icon={<Server className="h-8 w-8" />}
          title="Not connected"
          description="Connect to a Neon database or the Neon API to see live metrics."
          action={
            <Button onClick={() => (window.location.href = '/connect')}>Go to Connect</Button>
          }
        />
      </Card>
    )
  }
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">Connection details</h2>
      <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <Row label="Provider" value="Neon PostgreSQL" />
        <Row
          label="Mode"
          value={
            c.auth === 'api'
              ? c.accountOnly
                ? 'Neon API key (management only)'
                : 'Neon API key + database'
              : 'Database URL'
          }
        />
        {c.metadata?.projectName || c.metadata?.projectId ? (
          <Row label="Project" value={c.metadata.projectName ?? c.metadata.projectId ?? '—'} />
        ) : null}
        {c.metadata?.branchName || c.metadata?.branchId ? (
          <Row label="Branch" value={c.metadata.branchName ?? c.metadata.branchId ?? '—'} mono />
        ) : null}
        {c.metadata?.region ? <Row label="Region" value={c.metadata.region} mono /> : null}
        <Row label="Host" value={c.metadata?.host ?? '—'} mono />
        <Row label="Database" value={c.metadata?.database || (c.accountOnly ? '(control plane)' : '—')} mono />
        <Row label="Role" value={c.metadata?.role || '—'} mono />
        <Row
          label="Access"
          value={c.metadata?.readOnly ? 'read-only' : 'read/write'}
          badge={c.metadata?.readOnly ? <Badge tone="amber">read-only</Badge> : <Badge tone="green">read/write</Badge>}
        />
      </div>
    </Card>
  )
}

function Row({ label, value, mono, badge }: { label: string; value: string; mono?: boolean; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-1.5 last:border-0 dark:border-slate-700/50">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <span className={`text-slate-800 dark:text-slate-100 ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{badge ?? value}</span>
    </div>
  )
}