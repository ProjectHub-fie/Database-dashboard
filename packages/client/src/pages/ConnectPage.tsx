import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { Button, Input, Label, Badge } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { ConnectionStatus } from '../lib/types'
import {
  Database,
  KeyRound,
  ArrowRight,
  ShieldCheck,
  Table2,
  TerminalSquare,
  GitBranch,
  Lock,
} from 'lucide-react'

type Mode = 'url' | 'api'

export function ConnectPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const nav = useNavigate()
  const [mode, setMode] = useState<Mode>('url')
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ host: string; database: string; role: string; readOnly: boolean } | null>(null)

  const isConnUrl = auth.connection?.auth !== 'api'

  async function connect(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'url') {
        const res = await api.post<ConnectionStatus>('/api/connections/url', { providerId: 'neon', connectionString: url.trim() })
        toast('success', 'Connected to database', `${res.metadata?.database ?? ''} @ ${res.metadata?.host ?? ''}`)
      } else {
        const res = await api.post<ConnectionStatus & { organizations: Array<{ id: string; name: string }> }>(
          '/api/connections/api',
          { providerId: 'neon', apiKey: apiKey.trim() },
        )
        toast('success', 'Connected to Neon API', `${res.organizations?.length ?? 0} organization(s) found`)
      }
      await auth.reloadConnection()
      nav('/overview', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  async function handlePreview() {
    setError(null)
    try {
      const res = await api.post<{ host: string; database: string; role: string; readOnly: boolean; port: number }>(
        '/api/connections/preview',
        { providerId: 'neon', connectionString: url.trim() },
      )
      setPreview({ host: res.host, database: res.database, role: res.role, readOnly: res.readOnly })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not validate URL')
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950">
      <header className="border-b border-slate-200/80 dark:border-slate-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white dark:bg-white dark:text-slate-900">
              <Database className="h-[18px] w-[18px]" />
            </span>
            <div className="leading-tight">
              <p className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-white">DB Horizon</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Database Management Tool</p>
            </div>
          </div>
          <span className="hidden items-center gap-1.5 text-[11px] font-medium text-slate-500 sm:flex dark:text-slate-400">
            <Lock className="h-3 w-3" /> Credentials stay on the server
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24 pt-16 sm:pt-20">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-balance text-[34px] font-extrabold leading-[1.06] tracking-[-0.035em] text-slate-900 sm:text-5xl md:text-[56px] dark:text-white">
            Connect to Your Database
          </h1>
          <p className="mx-auto mt-5 max-w-[34rem] text-pretty text-[15px] leading-relaxed text-slate-600 sm:text-base dark:text-slate-400">
            Manage your remote Neon PostgreSQL databases with ease. Connect with a database URL or a
            Neon API key, then explore schemas, run queries, and manage your data.
          </p>
        </div>

        <div className="mx-auto mt-12 w-full max-w-[640px]">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-[0_1px_2px_rgba(9,9,11,0.04)] sm:p-8 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 dark:border-slate-700 dark:text-slate-200">
                <Database className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-white">Connect to Database</h2>
                <p className="text-[13px] text-slate-500 dark:text-slate-400">Choose how you want to connect</p>
              </div>
            </div>

            <div className="mt-6">
              <Label>Provider</Label>
              <select
                disabled
                className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 disabled:cursor-default dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
                value="neon"
                onChange={() => undefined}
                aria-label="Database provider"
              >
                <option value="neon">Neon PostgreSQL</option>
              </select>
              <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                Neon is the only enabled provider. Additional providers are planned.
              </p>
            </div>

            <div className="mt-5">
              <Label>Connection method</Label>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/60">
                <button
                  type="button"
                  onClick={() => { setMode('url'); setError(null) }}
                  className={segClass(mode === 'url')}
                  aria-pressed={mode === 'url'}
                >
                  <Database className="h-3.5 w-3.5" /> Database URL
                </button>
                <button
                  type="button"
                  onClick={() => { if (isConnUrl) { setMode('api'); setError(null) } }}
                  disabled={!isConnUrl}
                  className={segClass(mode === 'api')}
                  aria-pressed={mode === 'api'}
                >
                  <KeyRound className="h-3.5 w-3.5" /> Neon API key
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                {mode === 'url'
                  ? 'Direct PostgreSQL access to exactly one database. No account-wide Neon management in this mode.'
                  : 'Account-level access to manage projects, branches, databases and compute endpoints.'}
              </p>
            </div>

            <form onSubmit={connect} className="mt-5 space-y-4">
              {mode === 'url' ? (
                <>
                  <div>
                    <div className="flex items-center justify-between">
                      <Label>PostgreSQL connection string</Label>
                      <button
                        type="button"
                        onClick={handlePreview}
                        className="mb-1.5 text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-white"
                      >
                        Validate
                      </button>
                    </div>
                    <Input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="postgresql://role:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      className="font-mono text-xs"
                      aria-label="PostgreSQL connection string"
                    />
                  </div>
                  {preview && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-950/40">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-300">
                        <ShieldCheck className="h-3.5 w-3.5" /> Validated — credentials never reach the browser
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-4 dark:text-slate-400">
                        <div><dt className="sr-only">Host</dt><dd className="truncate font-mono">{preview.host}</dd></div>
                        <div><dt className="sr-only">Database</dt><dd className="font-mono">{preview.database}</dd></div>
                        <div><dt className="sr-only">Role</dt><dd className="font-mono">{preview.role}</dd></div>
                        <div>{preview.readOnly ? <Badge tone="amber">read-only role</Badge> : <Badge tone="green">read/write</Badge>}</div>
                      </dl>
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <Label>Neon API key</Label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="neon_xxxxxxxxxxxxxxxx"
                    autoComplete="off"
                    className="font-mono text-xs"
                    aria-label="Neon API key"
                  />
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                    Validated against the official Neon API and kept on the server. Prefer a
                    project-scoped key to reduce blast radius.
                  </p>
                </div>
              )}

              {error && (
                <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
                  {error}
                </div>
              )}

              <Button type="submit" loading={busy} className="mt-1 w-full">
                Connect to Database <ArrowRight className="h-4 w-4" />
              </Button>

              <p className="text-center text-[11px] text-slate-400 dark:text-slate-500">
                {mode === 'url'
                  ? 'The connection is temporary, never persisted, and closed when you disconnect.'
                  : 'Account mode unlocks Projects, Branches, Databases and Operations.'}
              </p>
            </form>
          </div>
        </div>

        <div className="mx-auto mt-14 grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Feature icon={<Table2 className="h-4 w-4" />} title="Browse Schema" body="Explore tables, views and constraints." />
          <Feature icon={<TerminalSquare className="h-4 w-4" />} title="Execute Queries" body="Write SQL with parameterized runs." />
          <Feature icon={<GitBranch className="h-4 w-4" />} title="Manage Data" body="Edit rows and manage branches safely." />
          <Feature icon={<ShieldCheck className="h-4 w-4" />} title="Safe by Design" body="TLS verified, SSRF guarded, secrets server-side." />
        </div>
      </main>
    </div>
  )
}

function segClass(active: boolean): string {
  return [
    'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
    active
      ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
    'disabled:cursor-not-allowed disabled:opacity-40',
  ].join(' ')
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
        {icon}
      </span>
      <p className="mt-3 text-[13px] font-semibold text-slate-900 dark:text-slate-100">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">{body}</p>
    </div>
  )
}
