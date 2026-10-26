import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useOnReconnect } from '../contexts/NetworkContext'
import { api, ApiError } from '../lib/api'
import { DatabaseStats } from '../lib/types'
import { Card, Badge, Skeleton, EmptyState, Button } from '../components/ui'
import { Activity, RefreshCw, Database, Boxes, Table2, PlugZap, Cpu } from 'lucide-react'

export function MonitoringPage() {
  const auth = useAuth()
  const [stats, setStats] = useState<DatabaseStats | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  const accountOnly = auth.connection?.accountOnly === true
  const readOnly = auth.connection?.metadata?.readOnly === true

  const load = async () => {
    setState('loading')
    setError(null)
    try {
      const r = await api.get<{ stats: DatabaseStats }>('/api/data/stats')
      setStats(r.stats)
      setState('ready')
    } catch (err) {
      setState('error')
      setError(err instanceof ApiError ? err.message : 'Could not load monitoring data')
    }
  }

  useEffect(() => {
    if (accountOnly) return
    void load()
    const id = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(id)
  }, [accountOnly])

  useOnReconnect(() => void load())

  if (accountOnly) {
    return (
      <EmptyState
        icon={<Activity className="h-10 w-10" />}
        title="Monitoring needs a database connection"
        description="Connect with a database URL to see live database health, connection counts, cache hit ratio and active queries."
      />
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Monitoring</h1>
        {readOnly && <Badge tone="amber">read-only</Badge>}
        <div className="ml-auto">
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {state === 'loading' && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      )}
      {state === 'error' && <EmptyState title="Monitoring unavailable" description={`${error ?? ''} The dashboard does not fabricate metrics — your role may lack permission to read pg_stat_* views.`} />}
      {state === 'ready' && stats && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Database size" value={formatBytes(stats.sizeBytes)} icon={<Database className="h-4 w-4" />} />
            <Metric label="Tables" value={String(stats.tableCount)} icon={<Table2 className="h-4 w-4" />} />
            <Metric label="Indexes" value={String(stats.indexCount)} icon={<Boxes className="h-4 w-4" />} />
            <Metric label="Cache hit ratio" value={stats.cacheHitRatio === null ? '—' : `${(stats.cacheHitRatio * 100).toFixed(1)}%`} icon={<Cpu className="h-4 w-4" />} />
          </div>

          <Card className="p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <PlugZap className="h-4 w-4 text-emerald-500" /> Active connections ({stats.connectionCount})
            </h2>
            {stats.activeConnections.length === 0 ? (
              <p className="text-sm text-slate-400">No active connections at the moment.</p>
            ) : (
              <div className="space-y-1.5">
                {stats.activeConnections.map((c) => (
                  <div key={c.pid} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/50">
                    <span className="font-mono text-slate-600 dark:text-slate-300">{c.pid}</span>
                    <span className="text-slate-500 dark:text-slate-400">{c.user} · {c.database}</span>
                    <Badge tone={c.state === 'active' ? 'green' : 'slate'}>{c.state ?? 'idle'}</Badge>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {c.query ?? '—'}
                    </code>
                    <span className="text-slate-400">{c.durationMs} ms</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-slate-900 dark:text-slate-100">{value}</div>
    </Card>
  )
}

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