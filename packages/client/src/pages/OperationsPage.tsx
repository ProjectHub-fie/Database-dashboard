import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useOnReconnect } from '../contexts/NetworkContext'
import { api, ApiError } from '../lib/api'
import { Project, ProviderOperation, Endpoint } from '../lib/types'
import { Badge, Button, Card, EmptyState, Select, Skeleton } from '../components/ui'
import { Cog, RefreshCw, Server, Activity, Clock } from 'lucide-react'
import { cn } from '../lib/cn'
import { capabilitiesOf } from '../lib/capabilities'

export function OperationsPage() {
  const auth = useAuth()
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [operations, setOperations] = useState<ProviderOperation[]>([])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [tab, setTab] = useState<'operations' | 'endpoints'>('operations')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  const accountOnly = auth.connection?.accountOnly === true
  const capabilities = capabilitiesOf(auth.connection)

  const load = useCallback(async () => {
    if (!selectedProject) {
      setState('ready')
      return
    }
    setState('loading')
    try {
      const [op, ep] = await Promise.all([
        api.get<{ operations: ProviderOperation[] }>(`/api/control/operations`, { projectId: selectedProject }),
        capabilities.includes('control.listEndpoints')
          ? api.get<{ endpoints: Endpoint[] }>(`/api/control/projects/${encodeURIComponent(selectedProject)}/endpoints`).catch(() => ({ endpoints: [] }))
          : Promise.resolve({ endpoints: [] }),
      ])
      setOperations(op.operations)
      setEndpoints(ep.endpoints)
      setState('ready')
    } catch (err) {
      setState('error')
      setError(err instanceof ApiError ? err.message : 'Could not load operations')
    }
  }, [selectedProject, capabilities])

  useEffect(() => {
    void api.get<{ projects: Project[] }>('/api/control/projects').then((r) => {
      setProjects(r.projects)
      if (r.projects[0]) setSelectedProject(r.projects[0].id)
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useOnReconnect(() => void load())

  const statusTone = (s: ProviderOperation['status']) =>
    s === 'finished' ? 'green' : s === 'failed' || s === 'error' || s === 'canceled' ? 'rose' : s === 'canceling' ? 'amber' : 'sky'

  if (!accountOnly) {
    return <EmptyState icon={<Cog className="h-10 w-10" />} title="Operations require API mode" description="Connect with a Neon API key to view asynchronous operations and compute endpoints." />
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Operations</h1>
        <div className="ml-auto flex items-center gap-2">
          <div className="w-72">
            <Select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-800">
        {(['operations', 'endpoints'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium capitalize',
              tab === t ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {state === 'loading' && <Skeleton className="h-48 w-full" />}
      {state === 'error' && <EmptyState title="Could not load" description={error} />}

      {state === 'ready' && tab === 'operations' && (
        <Card className="divide-y divide-slate-100 dark:divide-slate-700/60">
          {operations.length === 0 && <div className="p-6 text-center text-sm text-slate-400">No operations found for this project.</div>}
          {operations.map((op) => (
            <div key={op.id} className="flex items-center gap-3 px-4 py-3">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', op.status === 'finished' ? 'bg-emerald-500' : op.status === 'failed' ? 'bg-rose-500' : 'bg-sky-400 animate-pulse')} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800 dark:text-slate-100">{op.action}</span>
                  <Badge tone={statusTone(op.status)}>{op.status}</Badge>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                  <Clock className="h-3 w-3" />
                  {op.createdAt ? new Date(op.createdAt).toLocaleString() : '—'}
                  <span className="font-mono">{op.id.slice(0, 14)}…</span>
                  {op.projectId && <span className="font-mono">{op.projectId.slice(0, 8)}…</span>}
                </div>
                {op.error && <p className="mt-0.5 text-[11px] text-rose-500">{op.error}</p>}
              </div>
            </div>
          ))}
        </Card>
      )}

      {state === 'ready' && tab === 'endpoints' && (
        <Card className="divide-y divide-slate-100 dark:divide-slate-700/60">
          {endpoints.length === 0 && !projects.length && <div className="p-6 text-center text-sm text-slate-400">No endpoints.</div>}
          {endpoints.map((ep) => (
            <div key={ep.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Server className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium font-mono text-xs text-slate-800 dark:text-slate-100">{ep.host ?? ep.id}</span>
                  <Badge tone={ep.state.toLowerCase() === 'active' ? 'green' : 'sky'}>{ep.state}</Badge>
                  {ep.type && <Badge tone="slate">{ep.type}</Badge>}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                  <Activity className="h-3 w-3" /> {ep.region ?? '—'} · branch {ep.branchId.slice(0, 10)}…
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}