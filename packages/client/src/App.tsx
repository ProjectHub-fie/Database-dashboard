import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import { AppShell } from './components/AppShell'
import { ErrorBoundary, Spinner } from './components/ui'
import { LoginPage } from './pages/LoginPage'
import { OverviewPage } from './pages/OverviewPage'
import { DataBrowserPage } from './pages/DataBrowserPage'
import { SqlStudioPage } from './pages/SqlStudioPage'
import { SchemaManagerPage } from './pages/SchemaManagerPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { BranchesPage } from './pages/BranchesPage'
import { DatabasesPage } from './pages/DatabasesPage'
import { RolesPage } from './pages/RolesPage'
import { OperationsPage } from './pages/OperationsPage'
import { MonitoringPage } from './pages/MonitoringPage'
import { ImportExportPage } from './pages/ImportExportPage'
import { SettingsPage } from './pages/SettingsPage'
import { SecurityPage } from './pages/SecurityPage'
import { PrivacyPage, TermsPage } from './pages/LegalPages'

function Shell({ children }: { children: React.ReactNode }) {
  const auth = useAuth()
  const location = useLocation()

  if (auth.me === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    )
  }
  // Account sign-in is only mandatory while the server enforces it. When auth
  // is temporarily disabled, an anonymous visitor with a live connection may
  // use the dashboard; account-only screens (settings/security/audit) still
  // handle it themselves by showing sign-in prompts.
  const shellRequiresAuth = (auth.me.authRequired ?? true) && !auth.me.authenticated
  if (shellRequiresAuth) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }
  // Account-level screens must stay reachable without a database connection,
  // otherwise an operator can never rotate their bootstrap password.
  const ACCOUNT_PATHS = ['/connect', '/settings', '/security']
  const signedIn = auth.me.authenticated
  // Require a connection before any database management screen.
  // Anonymous visitors still need a live connection to enter the chrome; the
  // connect screen is the entry point either way. Signed-in users get the
  // account exemption as before.
  const needsConnection =
    auth.connection !== null &&
    !auth.connection.connected &&
    (signedIn ? !ACCOUNT_PATHS.includes(location.pathname) : true)
  if (needsConnection) {
    return <Navigate to="/connect" replace />
  }

  return (
    <ErrorBoundary>
      <AppShell>{children}</AppShell>
    </ErrorBoundary>
  )
}

/**
 * Entry route: the single screen that hosts all three sign-in/connection modes.
 *
 * It deliberately renders for signed-out *and* signed-in-but-not-connected
 * visitors — the connection tabs only work with a dashboard session, so
 * bouncing authenticated users elsewhere would split one flow across two URLs.
 * Rendered without the dashboard chrome.
 */
function EntryRoute({ children }: { children: React.ReactNode }) {
  const auth = useAuth()
  if (auth.me === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    )
  }
  if (auth.me.authenticated && auth.connection?.connected) {
    return <Navigate to="/overview" replace />
  }
  return <>{children}</>
}

/**
 * Dashboard routes need a live connection: every panel reads from the session's
 * pool or API key. Without one they can only render error states, so send the
 * visitor to the entry screen instead. Also covers a connection that is lost
 * mid-session, since AuthContext clears `connected` when the server says so.
 */
function RequireConnection({ children }: { children: React.ReactNode }) {
  const auth = useAuth()
  if (auth.me === null || auth.connection === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    )
  }
  if (!auth.connection.connected) return <Navigate to="/connect" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      {/* Both URLs render the same three-mode entry screen; /connect is kept so
          existing links and bookmarks keep working. */}
      <Route
        path="/login"
        element={
          <EntryRoute>
            <LoginPage />
          </EntryRoute>
        }
      />
      <Route
        path="/connect"
        element={
          <EntryRoute>
            <LoginPage />
          </EntryRoute>
        }
      />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route
        path="/*"
        element={
          <RequireConnection>
            <Shell>
              <Routes>
                <Route path="/overview" element={<OverviewPage />} />
                <Route path="/data" element={<DataBrowserPage />} />
                <Route path="/sql" element={<SqlStudioPage />} />
                <Route path="/schema" element={<SchemaManagerPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/branches" element={<BranchesPage />} />
                <Route path="/databases" element={<DatabasesPage />} />
                <Route path="/roles" element={<RolesPage />} />
                <Route path="/operations" element={<OperationsPage />} />
                <Route path="/monitoring" element={<MonitoringPage />} />
                <Route path="/io" element={<ImportExportPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/security" element={<SecurityPage />} />
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Routes>
            </Shell>
          </RequireConnection>
        }
      />
    </Routes>
  )
}