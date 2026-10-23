import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { Button, Card, Input, Label, Badge } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { ConnectionStatus } from '../lib/types'
import { ShieldCheck, KeyRound, Database, ArrowRight, Info } from 'lucide-react'

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

  const isControlPlane = auth.connection?.auth === 'api'
  const isConnUrl = !isControlPlane

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
      const msg = err instanceof ApiError ? err.message : 'Connection failed'
      setError(msg)
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
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Connect to Neon</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Choose how you want to reach your Neon databases. Credentials are handled exclusively on the server.
        </p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <ModeCard
          active={mode === 'url'}
          onClick={() => setMode('url')}
          icon={<Database className="h-5 w-5" />}
          title="Database URL"
          tagline="Direct PostgreSQL connection"
          description="Connect to exactly one database with a connection string. No account-level Neon management is available in this mode."
          disabled={!isConnUrl}
        />
        <ModeCard
          active={mode === 'api'}
          onClick={() => setMode('api')}
          icon={<KeyRound className="h-5 w-5" />}
          title="Neon API key"
          tagline="Account-level management"
          description="Manage projects, branches, databases and endpoints through the Neon control-plane API."
        />
      </div>

      <Card className="p-6">
        <form onSubmit={connect} className="space-y-4">
          {mode === 'url' ? (
            <>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <Label>PostgreSQL connection string</Label>
                  <button type="button" onClick={handlePreview} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    Validate URL
                  </button>
                </div>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="postgres://role:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </div>
              {preview && (
                <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
                  <div className="mb-1 flex items-center gap-1 font-medium text-slate-800 dark:text-slate-200">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Validated securely — no credentials leave the server
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                    <span>Host: <span className="font-mono">{preview.host}</span></span>
                    <span>Database: <span className="font-mono">{preview.database}</span></span>
                    <span>Role: <span className="font-mono">{preview.role}</span></span>
                    <span>{preview.readOnly ? <Badge tone="amber">read-only role</Badge> : <Badge tone="green">read/write</Badge>}</span>
                  </div>
                </div>
              )}
              <p className="flex items-start gap-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This mode never discovers your other Neon projects, and the URL is never saved or returned to your browser. TLS is verified with the pinned host.
              </p>
            </>
          ) : (
            <>
              <div>
                <Label>Neon API key</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="neon_xxxxxxxxxxxxxxxx"
                  autoComplete="off"
                  className="font-mono text-xs"
                />
              </div>
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The key is validated against the official Neon API and stays on the server. We recommend a <strong>project-scoped key</strong> to reduce blast radius — it can only manage the projects it is scoped to.
              </p>
            </>
          )}

          {error && (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>
          )}

          <div className="flex items-center justify-between pt-1">
            <div className="text-xs text-slate-400">
              {mode === 'url' ? 'Connection is temporary and never persisted.' : 'Account mode enables Projects, Branches, Databases & more.'}
            </div>
            <Button type="submit" loading={busy}>
              Connect <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  tagline,
  description,
  disabled,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  tagline: string
  description: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-left transition-all ${
        active
          ? 'border-indigo-500 bg-indigo-50/60 ring-2 ring-indigo-500/30 dark:border-indigo-400 dark:bg-indigo-500/10'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className={active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'}>{icon}</span>
        <span className="font-semibold text-slate-900 dark:text-slate-100">{title}</span>
        <span className="text-xs text-slate-400">{tagline}</span>
        {disabled && <Badge tone="slate">DB-URL mode</Badge>}
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{description}</p>
    </button>
  )
}