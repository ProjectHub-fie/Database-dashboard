import { useCallback, useEffect, useRef, useState, ReactNode } from 'react'
import { requestReauth, registerReauthHandler } from '../lib/reauth'
import { useAuth } from '../contexts/AuthContext'
import { Button, Input, Modal } from './ui'

/**
 * Global "recent reauthentication required" dialog. Sensitive actions
 * (deleting rows/tables/databases/branches/projects) are rejected server-side
 * after the reauth window lapses. This dialog collects the password once and
 * the failed request is retried automatically.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const close = useCallback((ok: boolean) => {
    setOpen(false)
    setPassword('')
    setError(null)
    resolver.current?.(ok)
    resolver.current = null
  }, [])

  useEffect(() => {
    registerReauthHandler((msg) => {
      setMessage(msg)
      setOpen(true)
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve
      })
    })
    return () => registerReauthHandler(() => Promise.resolve(false))
  }, [])

  const submit = useCallback(async () => {
    if (!password) return
    setBusy(true)
    setError(null)
    try {
      await auth.reauth(password)
      close(true)
    } catch {
      setError('The password you entered is incorrect. Try again.')
    } finally {
      setBusy(false)
    }
  }, [auth, password, close])

  const cancel = useCallback(() => close(false), [close])

  return (
    <>
      {children}
      <Modal
        open={open}
        onClose={cancel}
        title="Reauthentication required"
        hideClose={busy}
        footer={
          <>
            <Button variant="secondary" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} loading={busy}>
              Confirm password
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {message ??
            'This action is sensitive. Confirm your password within the current session to continue.'}
        </p>
        <div className="mt-4">
          <label htmlFor="reauth-password" className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Password
          </label>
          <Input
            id="reauth-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            autoComplete="current-password"
            autoFocus
          />
          {error ? <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}
        </div>
      </Modal>
    </>
  )
}

/** Convenience import for pages that want to trigger reauth explicitly. */
export { requestReauth }