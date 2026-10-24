import { useState, FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { Button, Input, Label } from '../components/ui'
import { ApiError } from '../lib/api'
import { Database, Lock } from 'lucide-react'

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
      setError(err instanceof ApiError ? err.message : 'Sign-in failed')
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950">
      <header className="border-b border-slate-200/80 dark:border-slate-800">
        <div className="mx-auto flex max-w-6xl items-center gap-2.5 px-6 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white dark:bg-white dark:text-slate-900">
            <Database className="h-[18px] w-[18px]" />
          </span>
          <div className="leading-tight">
            <p className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-white">DB Horizon</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Database Management Tool</p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col items-center px-6 pb-24 pt-16 sm:pt-20">
        <div className="w-full max-w-[420px]">
          <div className="text-center">
            <h1 className="text-[34px] font-extrabold leading-[1.06] tracking-[-0.035em] text-slate-900 sm:text-5xl md:text-[52px] dark:text-white">
              Welcome back
            </h1>
            <p className="mx-auto mt-4 max-w-[30rem] text-pretty text-[15px] leading-relaxed text-slate-600 dark:text-slate-400">
              Sign in to your dashboard. Your account is separate from any database or provider credentials.
            </p>
          </div>

          <form
            onSubmit={submit}
            className="mt-10 space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-[0_1px_2px_rgba(9,9,11,0.04)] dark:border-slate-800 dark:bg-slate-900"
          >
            {error && (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
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

          <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[11px] text-slate-400 dark:text-slate-500">
            <Lock className="h-3 w-3" /> Accounts are provisioned by the server administrator.
          </p>
        </div>
      </main>
    </div>
  )
}
