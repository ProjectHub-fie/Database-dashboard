import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { Button, Card, Input, Label, ConfirmDialog } from '../components/ui'
import { ShieldCheck, Unplug, RefreshCw, KeyRound } from 'lucide-react'

export function SettingsPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const nav = useNavigate()
  const [reauthOpen, setReauthOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

  const c = auth.connection

  async function submitPassword() {
    if (newPw.length < 12) {
      toast('error', 'The new password must be at least 12 characters')
      return
    }
    if (newPw !== confirmPw) {
      toast('error', 'The new passwords do not match')
      return
    }
    setPwBusy(true)
    try {
      await auth.changePassword(currentPw, newPw)
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
      setPwOpen(false)
      toast('success', 'Password changed. Other sessions were signed out.')
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Password change failed')
    } finally {
      setPwBusy(false)
    }
  }

  async function doReauth() {
    setBusy(true)
    try {
      await auth.reauth(password)
      setPassword('')
      setReauthOpen(false)
      toast('success', 'Authentication refreshed')
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Reauthentication failed')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await api.post('/api/connections/disconnect', {})
      toast('success', 'Database session disconnected')
      await auth.reloadConnection()
      nav('/connect')
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Disconnect failed')
    } finally {
      setBusy(false)
    }
  }

  async function reconnect() {
    setBusy(true)
    try {
      await api.post('/api/connections/disconnect', {})
      await new Promise((r) => setTimeout(r, 300))
      nav('/connect')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Settings</h1>

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">Connection</h2>
        {!c?.connected ? (
          <div className="py-2">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No database is connected. Connect from the connection screen to browse data, run SQL
              and manage resources.
            </p>
            <div className="mt-3">
              <Button size="sm" onClick={() => nav('/connect')}>
                Go to connection screen
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-x-6 gap-y-2 text-sm">
              <Row label="Mode" value={c.auth === 'api' ? 'Neon API key (management)' : 'Database URL'} />
              <Row label="Provider" value="Neon PostgreSQL" />
              <Row label="Host" value={c.metadata?.host || '—'} mono />
              <Row label="Database" value={c.metadata?.database || (c.accountOnly ? '(control plane)' : '—')} mono />
              <Row label="Role" value={c.metadata?.role || '—'} mono />
              <Row label="Access" value={c.metadata?.readOnly ? 'read-only' : 'read/write'} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setReauthOpen(true)}>
                <ShieldCheck className="h-3.5 w-3.5" /> Confirm password (reauth)
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void reconnect()}>
                <RefreshCw className="h-3.5 w-3.5" /> Reconnect
              </Button>
              <Button variant="danger" size="sm" onClick={() => void disconnect()} loading={busy}>
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">Account</h2>
        <div className="grid gap-x-6 gap-y-2 text-sm">
          <Row label="Signed in as" value={auth.me?.user?.username ?? '—'} mono />
        </div>
        {auth.me?.user?.mustChangePassword && (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
            This account still uses a password set from the server environment. Change it to a
            password only you know.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {auth.me?.user && (
            <Button variant="secondary" size="sm" onClick={() => setPwOpen(true)}>
              <KeyRound className="h-3.5 w-3.5" /> Change password
            </Button>
          )}
          {!auth.me?.user && (
            <Link
              to="/connect"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <KeyRound className="h-3.5 w-3.5" /> Sign in for account settings
            </Link>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">Security posture</h2>
        <ul className="space-y-1.5 text-xs text-slate-500 dark:text-slate-400">
          <li>• Credentials exist only in server memory for this dashboard session and are wiped on disconnect or sign-out.</li>
          <li>• Database connections use TLS with pinned hostname verification. Private-network destinations and DNS rebinding are blocked.</li>
          <li>• SQL values are parameterized; identifiers are validated and quoted. Destructive actions require confirmation and recent reauthentication where configured.</li>
          <li>• All operations are written to the server-side audit log without secrets.</li>
          <li>
            <strong className="text-amber-600 dark:text-amber-400">Limitation:</strong> dashboard authorization cannot stop someone who already has the database URL from connecting to PostgreSQL directly.
          </li>
        </ul>
      </Card>

      <ConfirmDialog
        open={pwOpen}
        title="Change password"
        tone="primary"
        message="Enter your current password and choose a new one of at least 12 characters. Every other signed-in device will be signed out."
        confirmText={pwBusy ? 'Saving…' : 'Change password'}
        onConfirm={() => void submitPassword()}
        onCancel={() => { setPwOpen(false); setCurrentPw(''); setNewPw(''); setConfirmPw('') }}
      >
        <div className="mt-2 space-y-3">
          <div>
            <Label>Current password</Label>
            <Input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} autoComplete="current-password" />
          </div>
          <div>
            <Label>New password</Label>
            <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
          </div>
          <div>
            <Label>Confirm new password</Label>
            <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={reauthOpen}
        title="Confirm your password"
        message="Recent reauthentication is required before sensitive actions such as deleting rows, tables, databases, branches or projects."
        confirmText="Confirm"
        onConfirm={() => void doReauth()}
        onCancel={() => { setReauthOpen(false); setPassword('') }}
      >
        <div className="mt-2">
          <Label>Password</Label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
        </div>
      </ConfirmDialog>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-1.5 dark:border-slate-700/50">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <span className={`text-right text-slate-800 dark:text-slate-100 ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{value}</span>
    </div>
  )
}