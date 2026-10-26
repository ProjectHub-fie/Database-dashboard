import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react'
import { api, ApiError, isTransportFailure, onConnectionLost } from '../lib/api'
import { ConnectionStatus } from '../lib/types'
import type { BootPhase } from '../components/loaders/PageLoader'
import { link } from '../lib/link'

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
  /**
   * Set when `/api` answered with something other than the API's JSON envelope
   * — in practice a platform error page, meaning this deployment never built
   * the API function. Surfaced as a banner so the cause is visible instead of
   * every panel failing with an opaque status.
   */
  apiUnreachable: boolean
  /**
   * Which bootstrap step is in flight, or null when bootstrapping is done.
   * Drives the full-page loader copy so it names the real step instead of
   * showing a generic spinner.
   */
  bootPhase: BootPhase | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [connection, setConnection] = useState<ConnectionStatus | null>(null)
  const [lastReauthAt, setLastReauthAt] = useState<number>(0)
  const [busy, setBusy] = useState(false)
  const [apiUnreachable, setApiUnreachable] = useState(false)
  const [bootPhase, setBootPhase] = useState<BootPhase | null>('initializing')

  const reloadConnection = useCallback(async () => {
    try {
      const status = await api.get<ConnectionStatus>('/api/connections/status')
      setConnection(status)
      setApiUnreachable(false)
    } catch (err) {
      // A dropped link is not an answer about the session. Reporting
      // `connected: false` here would bounce the operator to /connect and make
      // them re-enter credentials for a pool that is still open server-side.
      if (isTransportFailure(err)) return
      setConnection({ connected: false })
      if (err instanceof ApiError && err.code === 'API_UNREACHABLE') setApiUnreachable(true)
    }
  }, [])

  /**
   * A session can disappear server-side (idle expiry, restart, or a failover to
   * an instance that never held it). Drop the cached status so the shell stops
   * rendering connection chrome, and the route guard sends the user back to the
   * connect screen where they can authenticate again.
   */
  useEffect(() => onConnectionLost(() => setConnection({ connected: false })), [])

  /**
   * Ask the server who we are and whether a connection is live.
   *
   * `announce` drives the full-page loader. A re-bootstrap after an outage
   * passes false: the reconnect overlay is already covering the screen, and
   * flipping `me` back to null would tear down the page underneath it.
   */
  const bootstrap = useCallback(
    async (announce = true) => {
      if (announce) setBootPhase('initializing')
      try {
        const m = await api.get<MeResponse>('/api/auth/me')
        setMe(m)
      } catch (err) {
        // Same reasoning as reloadConnection: guessing "signed out" during an
        // outage sends a signed-in operator to the connect screen for what is
        // usually a two-second blip. Leave `me` null so the reconnect overlay
        // is what they see, and finish this bootstrap when the link returns.
        if (isTransportFailure(err)) return
        setMe({ authenticated: false })
        if (err instanceof ApiError && err.code === 'API_UNREACHABLE') setApiUnreachable(true)
      }
      setBootPhase('connecting')
      await reloadConnection()
      setBootPhase(null)
    },
    [reloadConnection],
  )

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  /**
   * A failed bootstrap used to be permanent: the first `/api/auth/me` after a
   * dead network fell into the catch, `me` became `{ authenticated: false }`,
   * and the operator landed on the connect screen with a valid session still
   * sitting on the server. Re-running the bootstrap when the link returns makes
   * that transient instead.
   */
  useEffect(() => {
    let previous = link.getSnapshot().state
    return link.subscribe((snapshot) => {
      if (previous === 'reconnecting' && snapshot.state === 'online') void bootstrap(false)
      previous = snapshot.state
    })
  }, [bootstrap])

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
    <AuthContext.Provider
      value={{
        me,
        connection,
        reloadConnection,
        login,
        logout,
        reauth,
        changePassword,
        reauthedRecently,
        busy,
        apiUnreachable,
        bootPhase,
      }}
    >
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