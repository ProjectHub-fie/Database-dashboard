import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react'
import { api, ApiError, onConnectionLost } from '../lib/api'
import { ConnectionStatus } from '../lib/types'

export interface MeResponse {
  authenticated: boolean
  /** Server policy: whether a dashboard account is mandatory for connections. */
  authRequired?: boolean
  /** True when this visitor holds an anonymous connection session. */
  anonymous?: boolean
  user?: { id: number; username: string; mustChangePassword: boolean }
}

interface AuthContextValue {
  /** Undefined while bootstrapping. */
  me: MeResponse | null
  connection: ConnectionStatus | null
  reloadConnection: () => Promise<void>
  login: (username: string, password: string) => Promise<MeResponse>
  logout: () => Promise<void>
  reauth: (password: string) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  /** True after a successful reauth within the TTL. */
  reauthedRecently: () => boolean
  busy: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [connection, setConnection] = useState<ConnectionStatus | null>(null)
  const [lastReauthAt, setLastReauthAt] = useState<number>(0)
  const [busy, setBusy] = useState(false)

  const reloadConnection = useCallback(async () => {
    try {
      const status = await api.get<ConnectionStatus>('/api/connections/status')
      setConnection(status)
    } catch {
      setConnection({ connected: false })
    }
  }, [])

  /**
   * A session can disappear server-side (idle expiry, restart, or a failover to
   * an instance that never held it). Drop the cached status so the shell stops
   * rendering connection chrome, and the route guard sends the user back to the
   * connect screen where they can authenticate again.
   */
  useEffect(() => onConnectionLost(() => setConnection({ connected: false })), [])

  useEffect(() => {
    let alive = true
    async function boot() {
      try {
        const m = await api.get<MeResponse>('/api/auth/me')
        if (!alive) return
        setMe(m)
      } catch {
        if (alive) setMe({ authenticated: false })
      }
      if (alive) void reloadConnection()
    }
    void boot()
    return () => {
      alive = false
    }
  }, [reloadConnection])

  const login = useCallback(async (username: string, password: string) => {
    setBusy(true)
    try {
      const m = await api.post<MeResponse>('/api/auth/login', { username, password })
      // Normalize: the session is authenticated by definition after a
      // successful login, regardless of exact response shape.
      const normalized: MeResponse = { ...m, authenticated: true }
      setMe(normalized)
      await reloadConnection()
      return normalized
    } finally {
      setBusy(false)
    }
  }, [reloadConnection])

  const logout = useCallback(async () => {
    setBusy(true)
    try {
      await api.post('/api/auth/logout', {})
    } catch {
      // Even if the server is unreachable, clear local state.
    } finally {
      setMe({ authenticated: false })
      setConnection({ connected: false })
      setBusy(false)
    }
  }, [])

  const reauth = useCallback(async (password: string) => {
    setBusy(true)
    try {
      await api.post('/api/auth/reauth', { password })
      setLastReauthAt(Date.now())
    } finally {
      setBusy(false)
    }
  }, [])

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    setBusy(true)
    try {
      await api.post('/api/auth/change-password', { currentPassword, newPassword })
      setMe((prev) =>
        prev?.user ? { ...prev, user: { ...prev.user, mustChangePassword: false } } : prev,
      )
      setLastReauthAt(Date.now())
    } finally {
      setBusy(false)
    }
  }, [])

  const reauthedRecently = useCallback(() => {
    // Reauth is valid 10 minutes after confirmation (matches server TTL).
    return Date.now() - lastReauthAt < 10 * 60 * 1000
  }, [lastReauthAt])

  return (
    <AuthContext.Provider value={{ me, connection, reloadConnection, login, logout, reauth, changePassword, reauthedRecently, busy }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export { ApiError }