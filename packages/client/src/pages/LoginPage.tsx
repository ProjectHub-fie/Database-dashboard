import { useCallback, useEffect, useMemo, useState, FormEvent } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { useTheme } from '../contexts/ThemeContext'
import { Button, Input, Label, Badge, Spinner } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { ConnectionStatus, ProviderCatalogEntry } from '../lib/types'
import { resolveCatalog, supportsAuthMethod, catalogIssueMessage } from '../lib/provider-catalog'
import {
  Database,
  KeyRound,
  UserRound,
  ArrowRight,
  Lock,
  Eye,
  EyeOff,
  Sun,
  Moon,
  Loader2,
  CircleCheck,
  CircleAlert,
  RefreshCw,
  ExternalLink,
} from 'lucide-react'

/**
 * Entry screen: the three ways into DB Horizon.
 *
 *  - Dashboard account → authenticates the person, creates the session cookie.
 *  - Database URL      → SQL access to exactly one database.
 *  - Provider API key  → control-plane access to the provider account.
 *
 * The two connection modes need a dashboard session: the API binds provider
 * credentials to the session id and `requireAuth` rejects them otherwise. The
 * tabs stay visible when signed out rather than hiding the product's
 * capabilities, and the forms explain the requirement, keeping typed values in
 * component state only (never storage).
 */

type Mode = 'url' | 'api' | 'account'

interface Preview {
  host: string
  database: string
  role: string
  readOnly: boolean
  port: number
}

interface ApiConnection {
  organizations?: Array<{ id: string; name: string }>
  /** Set when Neon refused /users/me because the key belongs to an organization. */
  organizationScoped?: boolean
}

export function LoginPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const { theme, toggle } = useTheme()
  const nav = useNavigate()
  const location = useLocation()

  const signedIn = auth.me?.authenticated === true
  // When the server runs with auth disabled, the URL/API modes are usable
  // without a dashboard account. Default to anonymous mode; only flip to the
  // account tab when the server explicitly says auth is required.
  const authRequired = auth.me?.authRequired === true

  // `null` follows the auth state; once the user picks a tab their choice wins.
  // Avoids a flash of the wrong tab while /auth/me is loading.
  const [picked, setPicked] = useState<Mode | null>(null)
  const mode: Mode = picked ?? (signedIn ? 'url' : authRequired ? 'account' : 'url')

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const [url, setUrl] = useState('')
  const [urlName, setUrlName] = useState('')
  const [showUrl, setShowUrl] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [testing, setTesting] = useState(false)

  const [apiKey, setApiKey] = useState('')
  const [apiName, setApiName] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }> | null>(null)
  const [orgScoped, setOrgScoped] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [debug, setDebug] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [providers, setProviders] = useState<ProviderCatalogEntry[] | null>(null)
  const [catalogIssue, setCatalogIssue] = useState<string | null>(null)
  const [providerId, setProviderId] = useState('neon')

  const loadProviders = useCallback(() => {
    setCatalogIssue(null)
    void api
      .get<{ providers: ProviderCatalogEntry[] }>('/api/providers')
      .then((r) => {
        setProviders(r.providers)
        const usable = r.providers.find((p) => p.available)
        if (usable) {
          setProviderId((current) => (r.providers.some((p) => p.id === current && p.available) ? current : usable.id))
        }
      })
      .catch((err: unknown) => {
        // A catalog failure must not blank the selector: the form would become
        // unusable even though the API accepts the provider it already defaults
        // to. Fall back to the single enabled provider and say so.
        setProviders(null)
        setCatalogIssue(catalogIssueMessage(err instanceof ApiError ? err.code : undefined))
      })
  }, [])

  useEffect(loadProviders, [loadProviders])

  // `neon` is the only provider the server registers today; this keeps the
  // connection forms usable when the catalog request fails.
  const providerOptions = resolveCatalog({ providers, issue: catalogIssue })

  const urlSupported = useMemo(
    () => supportsAuthMethod(providerOptions, providerId, 'connection'),
    [providerOptions, providerId],
  )
  const apiSupported = useMemo(
    () => supportsAuthMethod(providerOptions, providerId, 'api'),
    [providerOptions, providerId],
  )

  function switchMode(next: Mode) {
    setPicked(next)
    setError(null)
    setNotice(null)
  }

  function fail(err: unknown, fallback: string) {
    if (err instanceof ApiError) {
      // Surface enough diagnostics to debug without leaking secrets: HTTP
      // status, server error code and the tracing request id.
      setError(err.message)
      setDebug(
        `HTTP ${err.status} · ${err.code}${err.requestId ? ` · req ${err.requestId}` : ''}${
          err.code === 'NOT_FOUND'
            ? '\nThe API returned 404. If this is a fresh deploy, the old backend may still be live — try again in a minute.'
            : ''
        }`,
      )
    } else {
      setError(fallback)
      setDebug(null)
    }
  }

  function requireSignIn() {
    setNotice(
      'Sign in to your dashboard account to open this connection. What you typed stays in this page and is never written to browser storage.',
    )
    setPicked('account')
    void 0
  }

  async function submitAccount(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await auth.login(username.trim(), password)
      setPassword('')
      toast('success', 'Signed in')
      const from = (location.state as { from?: string } | null)?.from
      if (from && from !== '/login' && from !== '/connect') nav(from, { replace: true })
      else setPicked('url')
    } catch (err) {
      fail(err, 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  async function testUrl() {
    setError(null)
    setNotice(null)
    setPreview(null)
    if (!url.trim()) {
      setError('Paste a PostgreSQL connection string first.')
      return
    }
    setTesting(true)
    try {
      setPreview(
        await api.post<Preview>('/api/connections/preview', {
          providerId,
          connectionString: url.trim(),
        }),
      )
    } catch (err) {
      fail(err, 'Could not validate that connection string')
    } finally {
      setTesting(false)
    }
  }

  async function connectUrl(e: FormEvent) {
    e.preventDefault()
    if (!signedIn && authRequired) return requireSignIn()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const res = await api.post<ConnectionStatus>('/api/connections/url', {
        providerId,
        connectionString: url.trim(),
        ...(urlName.trim() ? { displayName: urlName.trim() } : {}),
      })
      toast('success', 'Connected', `${res.metadata?.database ?? ''} @ ${res.metadata?.host ?? ''}`)
      await auth.reloadConnection()
      setUrl('')
      setPreview(null)
      nav('/overview', { replace: true })
    } catch (err) {
      fail(err, 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  async function connectApi(e: FormEvent) {
    e.preventDefault()
    if (!signedIn && authRequired) return requireSignIn()
    setError(null)
    setNotice(null)
    setOrgs(null)
    setOrgScoped(false)
    setBusy(true)
    try {
      const res = await api.post<ConnectionStatus & ApiConnection>('/api/connections/api', {
        providerId,
        apiKey: apiKey.trim(),
        ...(apiName.trim() ? { displayName: apiName.trim() } : {}),
      })
      setOrgs(res.organizations ?? [])
      setOrgScoped(res.organizationScoped === true)
      toast(
        'success',
        'API key verified',
        res.organizationScoped
          ? 'Organization-scoped key accepted'
          : `${res.organizations?.length ?? 0} organization(s) visible to this key`,
      )
      await auth.reloadConnection()
      setApiKey('')
    } catch (err) {
      fail(err, 'Could not verify that API key')
    } finally {
      setBusy(false)
    }
  }

  async function signOutAndStay() {
    await auth.logout()
    setPicked('account')
    setOrgs(null)
    setPreview(null)
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
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-[11px] font-medium text-slate-500 sm:flex dark:text-slate-400">
              <Lock className="h-3 w-3" /> Credentials stay on the server
            </span>
            <button
              type="button"
              onClick={toggle}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24 pt-12 sm:pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-balance text-[32px] font-extrabold leading-[1.06] tracking-[-0.035em] text-slate-900 sm:text-[44px] dark:text-white">
            {signedIn ? 'Connect a database' : authRequired ? 'Sign in to DB Horizon' : 'Connect a database'}
          </h1>
          <p className="mx-auto mt-4 max-w-[34rem] text-pretty text-[15px] leading-relaxed text-slate-600 dark:text-slate-400">
            {signedIn
              ? 'Choose how this session reaches your database. Each connection is isolated to your session and closed on disconnect.'
              : authRequired
                ? 'Use a dashboard account for ongoing work, or connect with a database URL / provider API key.'
                : 'Choose how this session reaches your database. No dashboard account is needed right now.'}
          </p>
        </div>

        <div className="mx-auto mt-10 w-full max-w-[620px]">
          <div
            role="tablist"
            aria-label="Connection mode"
            className="grid grid-cols-1 gap-1 rounded-xl bg-slate-100 p-1 sm:grid-cols-3 dark:bg-slate-800/60"
          >
            <TabButton active={mode === 'url'} onClick={() => switchMode('url')} icon={<Database className="h-3.5 w-3.5" />} label="Database URL" locked={authRequired && !signedIn} />
            <TabButton active={mode === 'api'} onClick={() => switchMode('api')} icon={<KeyRound className="h-3.5 w-3.5" />} label="Provider API key" locked={authRequired && !signedIn} />
            <TabButton active={mode === 'account'} onClick={() => switchMode('account')} icon={<UserRound className="h-3.5 w-3.5" />} label="Dashboard account" locked={false} />
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 shadow-[0_1px_2px_rgba(9,9,11,0.04)] sm:p-7 dark:border-slate-800 dark:bg-slate-900">
            {notice && (
              <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                {notice}
              </div>
            )}
            {error && (
              <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
                <div className="flex items-start gap-2">
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span role="alert" className="flex-1">{error}</span>
                  {mode === 'url' && (
                    <button type="button" onClick={() => void testUrl()} className="shrink-0 font-medium underline underline-offset-2">
                      Retry
                    </button>
                  )}
                </div>
                {debug && (
                  <pre className="mt-1.5 overflow-x-auto rounded bg-rose-100/60 px-2 py-1 font-mono text-[11px] leading-4 text-rose-800/90 dark:bg-rose-900/40 dark:text-rose-200/90">
                    {debug}
                  </pre>
                )}
              </div>
            )}

            {mode === 'account' && (
              <AccountPanel
                signedIn={signedIn}
                accountName={auth.me?.user?.username ?? ''}
                mustChange={auth.me?.user?.mustChangePassword === true}
                username={username}
                setUsername={setUsername}
                password={password}
                setPassword={setPassword}
                showPassword={showPassword}
                setShowPassword={setShowPassword}
                busy={busy}
                onSubmit={submitAccount}
                onSignOut={() => void signOutAndStay()}
                onContinue={() => setPicked('url')}
              />
            )}

            {mode === 'url' && (
              <UrlPanel
                signedIn={signedIn}
                worksSignedOut={!authRequired}
                providers={providerOptions}
                catalogIssue={catalogIssue}
                onRetryProviders={loadProviders}
                providerId={providerId}
                setProviderId={setProviderId}
                url={url}
                setUrl={(v) => {
                  setUrl(v)
                  setPreview(null)
                }}
                displayName={urlName}
                setDisplayName={setUrlName}
                show={showUrl}
                setShow={setShowUrl}
                preview={preview}
                testing={testing}
                busy={busy}
                supported={urlSupported}
                onTest={authRequired && !signedIn ? requireSignIn : () => void testUrl()}
                onSubmit={connectUrl}
                onSignIn={requireSignIn}
              />
            )}

            {mode === 'api' && (
              <ApiPanel
                signedIn={signedIn}
                worksSignedOut={!authRequired}
                providers={providerOptions}
                catalogIssue={catalogIssue}
                onRetryProviders={loadProviders}
                providerId={providerId}
                setProviderId={setProviderId}
                apiKey={apiKey}
                setApiKey={setApiKey}
                displayName={apiName}
                setDisplayName={setApiName}
                show={showKey}
                setShow={setShowKey}
                busy={busy}
                supported={apiSupported}
                orgs={orgs}
                orgScoped={orgScoped}
                onSubmit={connectApi}
                onSignIn={requireSignIn}
                onOpen={() => nav('/overview', { replace: true })}
              />
            )}
          </div>

          <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
            Dashboard accounts are provisioned by the server administrator. Database and provider
            credentials are never stored in the browser or in the dashboard database.
          </p>
        </div>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  icon,
  label,
  locked,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  locked: boolean
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
        active
          ? 'bg-white text-slate-900 shadow-sm ring-1 ring-black/5 dark:bg-slate-700 dark:text-white dark:ring-white/10'
          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
      ].join(' ')}
    >
      {icon}
      {label}
      {locked && <Lock className="h-3 w-3 opacity-60" aria-label="requires sign-in" />}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Provider selector — driven by GET /api/providers, never a hardcoded table
// ---------------------------------------------------------------------------

function ProviderField({
  providers,
  catalogIssue,
  onRetry,
  value,
  onChange,
  authMethod,
}: {
  providers: ProviderCatalogEntry[] | null
  catalogIssue: string | null
  onRetry: () => void
  value: string
  onChange: (id: string) => void
  authMethod: 'connection' | 'api'
}) {
  if (!providers) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading providers…
      </div>
    )
  }

  const usable = providers.filter((p) => p.available && p.authMethods.includes(authMethod))
  const planned = providers.filter((p) => !p.available)

  return (
    <div>
      <Label>Provider</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Connection provider"
        className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      >
        {usable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.controlPlane && authMethod === 'api' ? ' — control plane' : ''}
          </option>
        ))}
        {usable.length === 0 && <option value="">No provider supports this mode yet</option>}
      </select>
      {catalogIssue && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          {catalogIssue}{' '}
          <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
            Retry
          </button>
        </p>
      )}
      {planned.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
          Planned, not available: {planned.map((p) => p.name).join(', ')}.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function AccountPanel(props: {
  signedIn: boolean
  accountName: string
  mustChange: boolean
  username: string
  setUsername: (v: string) => void
  password: string
  setPassword: (v: string) => void
  showPassword: boolean
  setShowPassword: (v: boolean) => void
  busy: boolean
  onSubmit: (e: FormEvent) => void
  onSignOut: () => void
  onContinue: () => void
}) {
  if (props.signedIn) {
    return (
      <div>
        <PanelHeading icon={<UserRound className="h-4 w-4" />} title="Dashboard account" subtitle="You are signed in." />
        <dl className="mt-5 space-y-2 text-[13px]">
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <dt className="text-slate-500 dark:text-slate-400">Signed in as</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{props.accountName}</dd>
          </div>
        </dl>
        {props.mustChange && (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            This account still uses its initial password.{' '}
            <Link to="/settings" className="font-medium underline underline-offset-2">
              Change it in Settings
            </Link>
            .
          </p>
        )}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button type="button" onClick={props.onContinue} className="flex-1">
            Continue to connection <ArrowRight className="h-4 w-4" />
          </Button>
          <Button type="button" variant="secondary" onClick={props.onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={props.onSubmit}>
      <PanelHeading icon={<UserRound className="h-4 w-4" />} title="Dashboard account" subtitle="Authorises this browser session." />
      <div className="mt-5 space-y-4">
        <div>
          <Label>Username</Label>
          <Input
            autoComplete="username"
            autoFocus
            value={props.username}
            onChange={(e) => props.setUsername(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </div>
        <div>
          <Label>Password</Label>
          <SecretInput
            value={props.password}
            onChange={props.setPassword}
            show={props.showPassword}
            onToggle={() => props.setShowPassword(!props.showPassword)}
            autoComplete="current-password"
            ariaLabel="Dashboard password"
          />
        </div>
      </div>
      <Button type="submit" loading={props.busy} className="mt-5 w-full">
        Sign in
      </Button>
    </form>
  )
}

function UrlPanel(props: {
  signedIn: boolean
  /** True when the server allows this mode without a dashboard account. */
  worksSignedOut: boolean
  providers: ProviderCatalogEntry[] | null
  catalogIssue: string | null
  onRetryProviders: () => void
  providerId: string
  setProviderId: (v: string) => void
  url: string
  setUrl: (v: string) => void
  displayName: string
  setDisplayName: (v: string) => void
  show: boolean
  setShow: (v: boolean) => void
  preview: Preview | null
  testing: boolean
  busy: boolean
  supported: boolean
  onTest: () => void
  onSubmit: (e: FormEvent) => void
  onSignIn: () => void
}) {
  return (
    <form onSubmit={props.onSubmit}>
      <PanelHeading
        icon={<Database className="h-4 w-4" />}
        title="Database URL"
        subtitle="Direct PostgreSQL access to exactly one database."
      />

      <div className="mt-5 space-y-4">
        <ProviderField
          providers={props.providers}
          catalogIssue={props.catalogIssue}
          onRetry={props.onRetryProviders}
          value={props.providerId}
          onChange={props.setProviderId}
          authMethod="connection"
        />

        <div>
          <div className="flex items-end justify-between gap-3">
            <Label>Connection string</Label>
            <button
              type="button"
              onClick={props.onTest}
              disabled={props.testing}
              className="mb-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline disabled:opacity-50 dark:text-slate-400 dark:hover:text-white"
            >
              {props.testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {props.testing ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          <SecretInput
            value={props.url}
            onChange={props.setUrl}
            show={props.show}
            onToggle={() => props.setShow(!props.show)}
            mono
            placeholder="postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require"
            ariaLabel="PostgreSQL connection string"
          />
        </div>

        <div>
          <Label>Display name (optional)</Label>
          <Input
            value={props.displayName}
            onChange={(e) => props.setDisplayName(e.target.value)}
            placeholder="Production read replica"
            maxLength={64}
            autoComplete="off"
          />
        </div>

        {props.preview && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/30">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-emerald-800 dark:text-emerald-300">
              <CircleCheck className="h-3.5 w-3.5" /> Host verified — no credentials reached the browser
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-700 sm:grid-cols-4 dark:text-slate-300">
              <Field label="Host" value={props.preview.host} />
              <Field label="Port" value={String(props.preview.port)} />
              <Field label="Database" value={props.preview.database} />
              <Field label="Role" value={props.preview.role} />
              <div className="col-span-2 sm:col-span-4">
                {props.preview.readOnly ? <Badge tone="amber">read-only role</Badge> : <Badge tone="green">read/write role</Badge>}
              </div>
            </dl>
          </div>
        )}

        {!props.supported && (
          <p className="rounded-lg border border-slate-200 px-3 py-2 text-[12px] text-slate-600 dark:border-slate-700 dark:text-slate-400">
            The selected provider does not support direct database URLs.
          </p>
        )}
      </div>

      <Button type="submit" loading={props.busy} disabled={!props.supported} className="mt-5 w-full">
        {props.signedIn || props.worksSignedOut ? 'Connect' : 'Sign in to connect'} <ArrowRight className="h-4 w-4" />
      </Button>
      {!props.signedIn && !props.worksSignedOut && (
        <p className="mt-3 text-center text-[11px] text-slate-400 dark:text-slate-500">
          A dashboard session is required before a connection can be opened.{' '}
          <button type="button" onClick={props.onSignIn} className="font-medium underline underline-offset-2">
            Sign in
          </button>
        </p>
      )}
    </form>
  )
}

function ApiPanel(props: {
  signedIn: boolean
  /** True when the server allows this mode without a dashboard account. */
  worksSignedOut: boolean
  providers: ProviderCatalogEntry[] | null
  catalogIssue: string | null
  onRetryProviders: () => void
  providerId: string
  setProviderId: (v: string) => void
  apiKey: string
  setApiKey: (v: string) => void
  displayName: string
  setDisplayName: (v: string) => void
  show: boolean
  setShow: (v: boolean) => void
  busy: boolean
  supported: boolean
  orgs: Array<{ id: string; name: string }> | null
  /** True when Neon refused /users/me because the key belongs to an organization. */
  orgScoped: boolean
  onSubmit: (e: FormEvent) => void
  onSignIn: () => void
  onOpen: () => void
}) {
  const docs = props.providers?.find((p) => p.id === props.providerId)?.apiDocs

  return (
    <form onSubmit={props.onSubmit}>
      <PanelHeading
        icon={<KeyRound className="h-4 w-4" />}
        title="Provider API key"
        subtitle="Manage provider resources. Separate from SQL access."
      />

      <div className="mt-5 space-y-4">
        <ProviderField
          providers={props.providers}
          catalogIssue={props.catalogIssue}
          onRetry={props.onRetryProviders}
          value={props.providerId}
          onChange={props.setProviderId}
          authMethod="api"
        />

        <div>
          <Label>API key</Label>
          <SecretInput
            value={props.apiKey}
            onChange={props.setApiKey}
            show={props.show}
            onToggle={() => props.setShow(!props.show)}
            mono
            placeholder="neon_xxxxxxxxxxxxxxxx"
            ariaLabel="Provider API key"
          />
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            Verified against the provider API before the session is created. Prefer a
            project-scoped key to limit blast radius.{' '}
            {docs && (
              <a
                href={docs}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
              >
                Where to get a key <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
        </div>

        <div>
          <Label>Display name (optional)</Label>
          <Input
            value={props.displayName}
            onChange={(e) => props.setDisplayName(e.target.value)}
            placeholder="Team Neon account"
            maxLength={64}
            autoComplete="off"
          />
        </div>

        {props.orgs && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/30">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-emerald-800 dark:text-emerald-300">
              <CircleCheck className="h-3.5 w-3.5" /> API key verified
            </div>
            <p className="mt-1.5 text-[11.5px] text-slate-700 dark:text-slate-300">
              {props.orgScoped
                ? 'Organization-scoped key. Neon does not let these read account-level details, so projects are listed directly.'
                : props.orgs.length === 0
                  ? 'This key can see your personal account but no organizations.'
                  : `${props.orgs.length} organization(s): ${props.orgs.map((o) => o.name).join(', ')}`}
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              Control-plane access only — no SQL connection is open yet. Pick a project, branch and
              database in the dashboard to query one.
            </p>
            <Button type="button" size="sm" onClick={props.onOpen} className="mt-2.5">
              Open dashboard <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {!props.supported && (
          <p className="rounded-lg border border-slate-200 px-3 py-2 text-[12px] text-slate-600 dark:border-slate-700 dark:text-slate-400">
            The selected provider does not support API-key mode.
          </p>
        )}
      </div>

      <Button type="submit" loading={props.busy} disabled={!props.supported} className="mt-5 w-full">
        {props.signedIn || props.worksSignedOut ? 'Verify and connect' : 'Sign in to connect'} <ArrowRight className="h-4 w-4" />
      </Button>
      {!props.signedIn && !props.worksSignedOut && (
        <p className="mt-3 text-center text-[11px] text-slate-400 dark:text-slate-500">
          A dashboard session is required before a provider key can be used.{' '}
          <button type="button" onClick={props.onSignIn} className="font-medium underline underline-offset-2">
            Sign in
          </button>
        </p>
      )}
    </form>
  )
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function PanelHeading({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 dark:border-slate-700 dark:text-slate-200">
        {icon}
      </span>
      <div>
        <h2 className="text-[16px] font-semibold tracking-tight text-slate-900 dark:text-white">{title}</h2>
        <p className="text-[12.5px] text-slate-500 dark:text-slate-400">{subtitle}</p>
      </div>
    </div>
  )
}

function SecretInput({
  value,
  onChange,
  show,
  onToggle,
  mono,
  placeholder,
  ariaLabel,
  autoComplete = 'off',
}: {
  value: string
  onChange: (v: string) => void
  show: boolean
  onToggle: () => void
  mono?: boolean
  placeholder?: string
  ariaLabel: string
  autoComplete?: string
}) {
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete={autoComplete}
        autoCapitalize="off"
        spellCheck={false}
        className={[
          'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 pe-10 text-sm text-slate-900 shadow-[0_1px_1px_rgba(9,9,11,0.03)] placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-slate-500 dark:focus:ring-white/10',
          mono ? 'font-mono text-xs' : '',
        ].join(' ')}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={show ? 'Hide value' : 'Show value'}
        aria-pressed={show}
        className="absolute end-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{label}</dt>
      <dd className="truncate font-mono">{value}</dd>
    </div>
  )
}

export function LoginLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  )
}
