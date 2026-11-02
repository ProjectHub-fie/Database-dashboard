import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { Button, Card, Input, Label, Badge, EmptyState } from '../components/ui'
import { ShieldCheck, Plus, Users, RefreshCw, CheckCircle2, XCircle, Activity } from 'lucide-react'

export interface OriginProbe {
  origin: string
  ok: boolean
  httpStatus: number
  latencyMs: number
  body: unknown
  error: string | null
}

export interface AdminUser {
  id: number
  username: string
  role: string
  createdAt: number
  mustChangePassword: boolean
}

export function AdminPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const [origins, setOrigins] = useState<string[]>([])
  const [checks, setChecks] = useState<OriginProbe[] | null>(null)
  const [running, setRunning] = useState(false)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const isAdmin = auth.me?.user?.role === 'admin'

  const loadEnv = useCallback(async () => {
    try {
      const res = await api.get<{ adminApiOrigins: string[] }>('/api/admin/env')
      setOrigins(res.adminApiOrigins)
    } catch {
      // Fall back to the empty list; the Run-checks button still works via
      // the request-origin fallback in the admin router.
    }
  }, [])

  const loadUsers = useCallback(async () => {
    try {
      const res = await api.get<{ users: AdminUser[] }>('/api/admin/users')
      setUsers(res.users)
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not load accounts')
    }
  }, [toast])

  useEffect(() => {
    void loadEnv()
    void loadUsers()
  }, [loadEnv, loadUsers])

  async function runChecks() {
    setRunning(true)
    try {
      const res = await api.get<{ checks: OriginProbe[] }>('/api/admin/checks')
      setChecks(res.checks)
    } catch (err) {
      setChecks(null)
      toast('error', err instanceof ApiError ? err.message : 'Checks failed')
    } finally {
      setRunning(false)
    }
  }

  async function createUser() {
    const name = username.trim()
    if (!name) {
      toast('error', 'Username is required')
      return
    }
    if (password.length < 12) {
      toast('error', 'The password must be at least 12 characters')
      return
    }
    setBusy(true)
    try {
      await api.post('/api/admin/users', { username: name, password })
      setUsername('')
      setPassword('')
      toast('success', `Account "${name}" created`)
      await loadUsers()
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not create account')
    } finally {
      setBusy(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-lg py-16">
        <Card className="p-8 text-center">
          <ShieldCheck className="mx-auto h-8 w-8 text-amber-500" />
          <h2 className="mt-3 text-lg font-semibold text-slate-900 dark:text-white">Admin portal</h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Sign in with an admin account to manage accounts and run deployment checks.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Administration</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Create dashboard accounts and verify the API deployments respond.
        </p>
      </header>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
              <Activity className="h-4 w-4" /> API origin checks
            </h2>
            <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
              {origins.length
                ? origins.join(', ')
                : 'No API_ORIGIN configured — will probe the origin this request arrived on.'}
            </p>
          </div>
          <Button onClick={runChecks} disabled={running} className="shrink-0">
            <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
            {running ? 'Running…' : 'Run checks'}
          </Button>
        </div>
        {checks && checks.length > 0 && (
          <ul className="mt-4 space-y-2">
            {checks.map((c) => (
              <li
                key={c.origin}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {c.ok ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="h-4 w-4 shrink-0 text-rose-500" />
                  )}
                  <span className="truncate font-mono text-xs">{c.origin}/api/healthz</span>
                </span>
                <Badge tone={c.ok ? 'green' : 'rose'}>
                  {c.ok ? `${c.httpStatus} · ${c.latencyMs}ms` : (c.error ?? `HTTP ${c.httpStatus}`)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {checks && checks.length === 0 && (
          <p className="mt-4 text-xs text-slate-500">No origins to probe.</p>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
          <Plus className="h-4 w-4" /> Create account
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Username</Label>
            <Input
              id="ad-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ops-user"
            />
          </div>
          <div>
            <Label>
              Password <span className="font-normal text-slate-400">(min 12 chars)</span>
            </Label>
            <Input
              id="ad-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          <span className="text-xs text-slate-400">
            The account must change its password on first sign-in.
          </span>
          <Button onClick={createUser} disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
          <Users className="h-4 w-4" /> Accounts ({users.length})
        </h2>
        {users.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No accounts yet" description="Create the first account above." />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {users.map((u) => (
              <li key={u.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm font-medium text-slate-900 dark:text-white">{u.username}</p>
                  <p className="text-xs text-slate-400">created {new Date(u.createdAt).toLocaleString()}</p>
                </div>
                <Badge tone={u.mustChangePassword ? 'amber' : 'green'}>
                  {u.mustChangePassword ? 'Must change password' : 'Active'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}