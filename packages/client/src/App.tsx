import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import { AppShell } from './components/AppShell'
import { ErrorBoundary, Spinner } from './components/ui'
import { LoginPage } from './pages/LoginPage'
import { ConnectPage } from './pages/ConnectPage'
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
  if (!auth.me.authenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }
  // Require a connection before any database management screen.
  if (auth.connection !== null && !auth.connection.connected && location.pathname !== '/connect') {
    return <Navigate to="/connect" replace />
  }
  if (auth.connection?.connected && location.pathname === '/connect') {
    return <Navigate to="/overview" replace />
  }

  return (
    <ErrorBoundary>
      <AppShell>{children}</AppShell>
    </ErrorBoundary>
  )
}

function PublicRoute({ children }: { children: React.ReactNode }) {
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
  if (auth.me.authenticated) {
    return <Navigate to="/connect" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/connect"
        element={
          <Shell>
            <ConnectPage />
          </Shell>
        }
      />
      <Route
        path="/*"
        element={
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
        }
      />
    </Routes>
  )
}