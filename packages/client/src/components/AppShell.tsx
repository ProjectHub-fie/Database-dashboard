import { ReactNode, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '../lib/cn'
import { useTheme } from '../contexts/ThemeContext'
import { useAuth } from '../contexts/AuthContext'
import {
  LayoutDashboard,
  Database,
  TerminalSquare,
  Table2,
  FolderOpen,
  GitBranch,
  Layers,
  KeyRound,
  Cog,
  Activity,
  ArrowUpDown,
  Settings,
  ShieldCheck,
  Search,
  Sun,
  Moon,
  Menu,
  X,
  LogOut,
  ChevronRight,
  Command,
} from 'lucide-react'
import { Badge } from './ui'

interface NavItem {
  to: string
  label: string
  icon: ReactNode
  /** Sections that only apply to control-plane (API-key) mode. */
  controlOnly?: boolean
}

const NAV: NavItem[] = [
  { to: '/overview', label: 'Overview', icon: <LayoutDashboard className="h-4 w-4" /> },
  { to: '/data', label: 'Data Browser', icon: <Database className="h-4 w-4" /> },
  { to: '/sql', label: 'SQL Studio', icon: <TerminalSquare className="h-4 w-4" /> },
  { to: '/schema', label: 'Schema Manager', icon: <Table2 className="h-4 w-4" /> },
  { to: '/projects', label: 'Projects', icon: <FolderOpen className="h-4 w-4" />, controlOnly: true },
  { to: '/branches', label: 'Branches', icon: <GitBranch className="h-4 w-4" />, controlOnly: true },
  { to: '/databases', label: 'Databases', icon: <Layers className="h-4 w-4" />, controlOnly: true },
  { to: '/roles', label: 'Roles & Access', icon: <KeyRound className="h-4 w-4" /> },
  { to: '/operations', label: 'Operations', icon: <Cog className="h-4 w-4" />, controlOnly: true },
  { to: '/monitoring', label: 'Monitoring', icon: <Activity className="h-4 w-4" /> },
  { to: '/io', label: 'Import / Export', icon: <ArrowUpDown className="h-4 w-4" /> },
  { to: '/settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
  { to: '/security', label: 'Security & Audit', icon: <ShieldCheck className="h-4 w-4" /> },
]

function SidebarLink({ item, onClick }: { item: NavItem; onClick?: () => void }) {
  return (
    <NavLink
      to={item.to}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700/60 dark:hover:text-slate-100',
        )
      }
    >
      {item.icon}
      <span className="flex-1 truncate">{item.label}</span>
    </NavLink>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, toggle } = useTheme()
  const auth = useAuth()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const isControlPlane = auth.connection?.auth === 'api'
  const visibleNav = NAV.filter((n) => !(n.controlOnly && !isControlPlane))

  const segments = location.pathname.split('/').filter(Boolean)
  const crumbs = ['Home', ...segments.map((s) => decodeURIComponent(s.charAt(0).toUpperCase() + s.slice(1)))]

  const sidebar = (onNav?: () => void) => (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        {!collapsed && (
          <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600 text-xs font-bold text-white">DB</span>
            <span>DB Horizon</span>
          </div>
        )}
        {!collapsed && (
          <button
            onClick={() => setPaletteOpen(true)}
            className="hidden items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-700 lg:flex"
          >
            <Command className="h-3 w-3" /> Ctrl K
          </button>
        )}
        {collapsed && <div />}
        {!collapsed && (
          <button onClick={() => setDrawerOpen(false)} aria-label="Close navigation" className="rounded p-1 text-slate-400 hover:bg-slate-100 lg:hidden">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2" aria-label="Sidebar">
        {visibleNav.map((item) => (
          <SidebarLink key={item.to} item={item} onClick={onNav} />
        ))}
      </nav>
      <div className="shrink-0 border-t border-slate-200 p-2 dark:border-slate-700">
        <ConnectionPill />
      </div>
    </div>
  )

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden shrink-0 border-r border-slate-200 bg-white transition-[width] duration-200 lg:block dark:border-slate-700 dark:bg-slate-800',
          collapsed ? 'w-14' : 'w-64',
        )}
      >
        {sidebar()}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800">
            {sidebar(() => setDrawerOpen(false))}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-800">
          <button onClick={() => setDrawerOpen(true)} aria-label="Open navigation" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden">
            <Menu className="h-5 w-5" />
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label="Collapse sidebar"
            className="hidden rounded p-1.5 text-slate-500 hover:bg-slate-100 lg:block"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="hidden items-center gap-1 sm:flex">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1 text-sm">
                {i > 0 && <ChevronRight className="h-3 w-3 text-slate-400" />}
                <span className={i === crumbs.length - 1 ? 'font-medium text-slate-900 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400'}>
                  {c}
                </span>
              </span>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label="Command palette"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              <Search className="h-3.5 w-3.5" /> Global
            </button>
            <button
              onClick={toggle}
              aria-label="Toggle theme"
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              onClick={() => void auth.logout()}
              aria-label="Sign out"
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} items={visibleNav} />}
    </div>
  )
}

function ConnectionPill() {
  const auth = useAuth()
  const c = auth.connection
  if (!c?.connected) {
    return (
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-500 dark:text-slate-400">
        <span className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-500" />
        Not connected
      </div>
    )
  }
  const label = c.accountOnly ? 'Neon account (API)' : `${c.metadata?.database ?? ''} @ ${c.metadata?.host ?? 'db'}`
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <Badge tone="green">{c.auth === 'api' ? 'API key' : c.metadata?.readOnly ? 'Read-only' : 'Read/write'}</Badge>
      </div>
      <p className="truncate px-2 text-[11px] text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  )
}

function CommandPalette({
  onClose,
  items,
}: {
  onClose: () => void
  items: Array<{ to: string; label: string; icon: ReactNode }>
}) {
  const auth = useAuth()
  const [q, setQ] = useState('')
  const filtered = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 10)
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center pt-24">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
            placeholder="Search pages…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {filtered.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
          {filtered.length === 0 && <p className="px-3 py-4 text-center text-sm text-slate-400">No pages match “{q}”</p>}
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400 dark:border-slate-700">
          <span>Navigate pages · Esc to close</span>
          {auth.connection?.accountOnly ? <Badge tone="indigo">API mode</Badge> : null}
        </div>
      </div>
    </div>
  )
}