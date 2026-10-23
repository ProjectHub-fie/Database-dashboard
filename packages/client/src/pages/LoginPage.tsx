import { useState, FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { Button, Input, Label } from '../components/ui'
import { ApiError } from '../lib/api'

export function LoginPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const nav = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await auth.login(username.trim(), password)
      toast('success', 'Signed in')
      nav((location.state as { from?: string })?.from ?? '/connect', { replace: true })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Sign-in failed'
      setError(msg)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-900">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white">DB</span>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Sign in to DB Horizon</h1>
          <p className="text-center text-sm text-slate-500 dark:text-slate-400">
            Your sign-in is separate from any database or provider credentials.
          </p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          {error && (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </div>
          )}
          <div>
            <Label>Username</Label>
            <Input
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div>
            <Label>Password</Label>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <Button type="submit" loading={auth.busy} className="w-full">
            Sign in
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-400">
          The server administrator provisions accounts. Connection credentials are entered after sign-in.
        </p>
      </div>
    </div>
  )
}