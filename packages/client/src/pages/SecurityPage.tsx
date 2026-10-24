import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { Button, Card, Badge, EmptyState, Skeleton } from '../components/ui'
import { ShieldCheck, KeyRound, Database, AlertTriangle, BookOpen, RotateCcw } from 'lucide-react'

interface AuditEvent {
  id?: number
  userId?: number | null
  sessionId?: string
  event: string
  status: 'ok' | 'fail'
  target?: string
  detail?: string
  createdAt?: number
}

export function SecurityPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [filter, setFilter] = useState('')

  const c = auth.connection

  useEffect(() => {
    void api
      .get<{ events: AuditEvent[] }>('/api/audit', { limit: 100 })
      .then((r) => {
        setAudit(r.events)
        setState('ready')
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN' || err.code === 'UNAUTHORIZED')) {
          setState('ready') // audit endpoint may not be exposed
        } else setState('error')
        toast('info', 'Audit log unavailable', err instanceof ApiError ? err.message : undefined)
      })
  }, [toast])

  const filtered = audit.filter((a) => `${a.event} ${a.detail ?? ''} ${a.target ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  const hasAuditRoute = state === 'ready' && audit.length > 0

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Security & Audit</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            <ShieldCheck className="h-4 w-4 text-emerald-500" /> Connection
          </div>
          <p className="mt-2 text-sm text-slate-800 dark:text-slate-100">
            {c?.connected ? (c.auth === 'api' ? 'Neon API key (management)' : 'Database URL') : 'Not connected'}
          </p>
          <p className="mt-1 text-xs text-slate-400">{c?.metadata?.database || '—'}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            <KeyRound className="h-4 w-4 text-amber-500" /> Credentials
          </div>
          <p className="mt-2 text-sm text-slate-800 dark:text-slate-100">Server memory only</p>
          <p className="mt-1 text-xs text-slate-400">Never persisted, never in the browser, never in logs.</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            <Database className="h-4 w-4 text-sky-500" /> TLS
          </div>
          <p className="mt-2 text-sm text-slate-800 dark:text-slate-100">Verified + pinned</p>
          <p className="mt-1 text-xs text-slate-400">rejectUnauthorized with hostname validation; DNS-rebinding protected.</p>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> Understand the limits of dashboard security
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          DB Horizon protects the <em>dashboard session</em> and the server-side connection. If a PostgreSQL connection URL or Neon API key is leaked, anyone holding it can connect to your resources directly — no dashboard that only checks its own sessions can prevent that. Treat connection strings and API keys as secrets: rotate them when they may have leaked, scope API keys to specific projects, and revoke leaked keys immediately at the provider.
        </p>
      </Card>

      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Audit log</h2>
          <div className="flex items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter events…"
              className="w-48 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />
            <Button size="sm" variant="secondary" onClick={() => { setState('loading'); void api.get<{ events: AuditEvent[] }>('/api/audit', { limit: 100 }).then((r) => { setAudit(r.events); setState('ready') }).catch(() => setState('ready')) }}>
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>
        </div>
        {state === 'loading' && <Skeleton className="h-32 w-full" />}
        {state === 'ready' && (
          hasAuditRoute ? (
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900">
                  <tr>
                    <th className="px-2 py-1.5 text-slate-500">When</th>
                    <th className="px-2 py-1.5 text-slate-500">Event</th>
                    <th className="px-2 py-1.5 text-slate-500">Status</th>
                    <th className="px-2 py-1.5 text-slate-500">Target</th>
                    <th className="px-2 py-1.5 text-slate-500">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e, i) => (
                    <tr key={e.id ?? i} className="border-t border-slate-100 align-top dark:border-slate-700/40">
                      <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">{e.createdAt ? new Date(e.createdAt).toLocaleString() : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-slate-700 dark:text-slate-200">{e.event}</td>
                      <td className="px-2 py-1.5"><Badge tone={e.status === 'ok' ? 'green' : 'rose'}>{e.status}</Badge></td>
                      <td className="max-w-[160px] truncate px-2 py-1.5 font-mono text-slate-500 dark:text-slate-400">{e.target ?? '—'}</td>
                      <td className="max-w-[260px] truncate px-2 py-1.5 text-slate-500 dark:text-slate-400">{e.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <p className="p-4 text-center text-sm text-slate-400">No audit events match.</p>}
            </div>
          ) : (
            <EmptyState
              icon={<BookOpen className="h-8 w-8" />}
              title="Audit events are stored server-side"
              description="The server records sign-ins, connection/disconnect, SQL execution, schema changes and destructive actions. If the audit endpoint is disabled for this deployment, ask the administrator for server logs."
            />
          )
        )}
      </Card>
    </div>
  )
}