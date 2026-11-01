import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useOnReconnect } from '../contexts/NetworkContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { Project, Branch, Database, DatabaseRole, ProviderOperation } from '../lib/types'
import { Button, Card, Badge, EmptyState, Input, Label, Select, Modal, ConfirmDialog, Skeleton } from '../components/ui'
import { Layers, Plus, Trash2, Server, Copy, Plug, PlugZap } from 'lucide-react'
import { capabilitiesOf } from '../lib/capabilities'

export function DatabasesPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const [params] = useSearchParams()
  const projectParam = params.get('project') ?? ''

  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState(projectParam)
  const [branches, setBranches] = useState<Branch[]>([])
  const [selectedBranch, setSelectedBranch] = useState<string>('')
  const [databases, setDatabases] = useState<Database[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newOwner, setNewOwner] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Database | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [connInfo, setConnInfo] = useState<{ displayName: string; host: string; port: number; database: string; role: string } | null>(null)
  const [copyText, setCopyText] = useState('')
  const [attaching, setAttaching] = useState<string | null>(null)
  // Attach dialog: a role must be chosen explicitly, because `connection_uri`
  // requires one and silently defaulting to the owner role would open a
  // higher-privileged session than the operator asked for.
  const [attachTarget, setAttachTarget] = useState<Database | null>(null)
  const [roles, setRoles] = useState<DatabaseRole[]>([])
  const [rolesState, setRolesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [selectedRole, setSelectedRole] = useState('')
  const nav = useNavigate()

  const capabilities = capabilitiesOf(auth.connection)
  const canCreate = capabilities.includes('control.createDatabase')
  const canDelete = capabilities.includes('control.deleteDatabase')

  useEffect(() => {
    void api.get<{ projects: Project[] }>('/api/control/projects').then((r) => {
      setProjects(r.projects)
      if (!projectParam && r.projects[0] && !selectedProject) setSelectedProject(r.projects[0].id)
    }).catch(() => undefined)
  }, [])

  // Load branches when a project is chosen.
  useEffect(() => {
    if (!selectedProject) return
    void api
      .get<{ branches: Branch[] }>(`/api/control/projects/${encodeURIComponent(selectedProject)}/branches`)
      .then((r) => {
        setBranches(r.branches)
        const primary = r.branches.find((b) => b.primary)
        setSelectedBranch((cur) => (r.branches.find((b) => b.id === cur) ? cur : (primary?.id ?? r.branches[0]?.id ?? '')))
      })
      .catch(() => undefined)
  }, [selectedProject])

  const load = useCallback(async () => {
    if (!selectedProject || !selectedBranch) {
      setState('ready')
      return
    }
    setState('loading')
    try {
      const r = await api.get<{ databases: Database[] }>(`/api/control/projects/${encodeURIComponent(selectedProject)}/databases`, {
        branchId: selectedBranch,
      })
      setDatabases(r.databases)
      setState('ready')
    } catch (err) {
      setState('error')
      setError(err instanceof ApiError ? err.message : 'Could not load databases')
    }
  }, [selectedProject, selectedBranch])

  useEffect(() => {
    void load()
  }, [load])
  useOnReconnect(() => void load())

  async function createDatabase() {
    if (!selectedProject || !selectedBranch || !newName.trim()) return
    setCreating(true)
    try {
      await api.post<{ database: Database; operation?: ProviderOperation }>(
        `/api/control/projects/${encodeURIComponent(selectedProject)}/databases`,
        { branchId: selectedBranch, name: newName.trim(), owner: newOwner.trim() || undefined },
      )
      toast('success', `Database ${newName.trim()} created`)
      setCreateOpen(false)
      setNewName('')
      void load()
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not create database')
    } finally {
      setCreating(false)
    }
  }

  function confirmDelete() {
    if (!deleteTarget || confirmText.trim() !== deleteTarget.name) return
    void api
      .del<{ operation?: ProviderOperation }>(`/api/control/projects/${encodeURIComponent(deleteTarget.projectId)}/databases/${encodeURIComponent(deleteTarget.name)}`, undefined, {
        branchId: deleteTarget.branchId,
        confirm: deleteTarget.name,
      })
      .then(() => {
        toast('success', `Deleting database ${deleteTarget.name}`)
        setDeleteTarget(null)
        setConfirmText('')
        void load()
      })
      .catch((err) => toast('error', err instanceof ApiError ? err.message : 'Delete failed'))
  }

  const attachedDatabase =
    auth.connection?.auth === 'api' && auth.connection?.accountOnly !== true
      ? auth.connection.metadata?.database
      : undefined

  /** Load the branch's roles and open the attach dialog for a database. */
  async function openAttach(db: Database) {
    setAttachTarget(db)
    setSelectedRole('')
    setRoles([])
    setRolesError(null)
    setRolesState('loading')
    try {
      const r = await api.get<{ roles: DatabaseRole[] }>(
        `/api/control/projects/${encodeURIComponent(db.projectId)}/roles`,
        { branchId: db.branchId },
      )
      setRoles(r.roles)
      // Preselect the database owner when it is a usable password role: that is
      // the role that actually owns the objects, so it is the least surprising
      // choice — but it still requires a click, never a silent default.
      const usable = r.roles.filter((role) => !role.authenticationMethod || role.authenticationMethod === 'password')
      const owner = usable.find((role) => role.name === db.owner)
      setSelectedRole(owner?.name ?? (usable.length === 1 ? usable[0].name : ''))
      setRolesState('ready')
    } catch (err) {
      setRolesState('error')
      setRolesError(err instanceof ApiError ? err.message : 'Could not load roles for this branch')
    }
  }

  /**
   * Open a real SQL session for this database using the API key that is already
   * on the server. The credential never crosses to the browser: the server asks
   * Neon for a URI, verifies and pins the host, and returns metadata only.
   */
  async function attachDatabase() {
    const db = attachTarget
    if (!db || !selectedRole) return
    setAttaching(db.name)
    try {
      await api.post('/api/connections/database', {
        projectId: db.projectId,
        branchId: db.branchId,
        databaseName: db.name,
        role: selectedRole,
      })
      await auth.reloadConnection()
      toast('success', `Connected to ${db.name}`, `Session role: ${selectedRole}. Data, SQL and schema tools are now available.`)
      setAttachTarget(null)
      nav('/overview')
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not open a database connection')
    } finally {
      setAttaching(null)
    }
  }

  async function getConnectionString(db: Database) {
    try {
      const r = await api.get<{ info: { displayName: string; host: string; port: number; database: string; role: string } }>(
        '/api/control/connection-info',
        { projectId: db.projectId, branchId: db.branchId, databaseName: db.name },
      )
      setConnInfo(r.info)
      setCopyText('')
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not fetch connection info')
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Databases</h1>
        <div className="ml-auto flex items-center gap-2">
          <div className="w-56">
            <Select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <div className="w-56">
            <Select value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.primary ? ' (primary)' : ''}</option>)}
            </Select>
          </div>
          {canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New database
            </Button>
          )}
        </div>
      </div>

      {auth.connection?.auth === 'api' && auth.connection?.accountOnly === true && (
        <Card className="border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900/60 dark:bg-sky-950/30">
          <p className="text-[12.5px] text-slate-700 dark:text-slate-300">
            The API key manages Neon resources. Choose <strong>Use database</strong> on a database
            below to open a SQL session — Data Browser, SQL Studio and Schema Manager become
            available once a database is attached. Permissions still come from the role the URI
            uses, not from this dashboard.
          </p>
        </Card>
      )}

      {state === 'loading' && <Skeleton className="h-32 w-full" />}
      {state === 'error' && <EmptyState title="Could not load databases" description={error} />}
      {state === 'ready' && databases.length === 0 && (
        <EmptyState icon={<Layers className="h-10 w-10" />} title="No databases on this branch" description="Create a database to get started." />
      )}
      {state === 'ready' && databases.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {databases.map((d) => (
            <Card key={d.name} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-sky-400" />
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{d.name}</span>
                  {d.owner && <Badge tone="slate">owner {d.owner}</Badge>}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={attachedDatabase === d.name ? 'secondary' : 'primary'}
                    loading={attaching === d.name}
                    disabled={Boolean(attaching) || attachedDatabase === d.name}
                    onClick={() => void openAttach(d)}
                    title="Open a SQL session on this database with the API key"
                  >
                    {attachedDatabase === d.name ? (
                      <><PlugZap className="h-3.5 w-3.5" /> Connected</>
                    ) : (
                      <><Plug className="h-3.5 w-3.5" /> Use database</>
                    )}
                  </Button>
                  <button onClick={() => void getConnectionString(d)} className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600 dark:hover:bg-slate-700" title="Connection info">
                    <Server className="h-4 w-4" />
                  </button>
                  {canDelete && (
                    <button
                      onClick={() => { setDeleteTarget(d); setConfirmText('') }}
                      className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                      title="Delete database"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-2 font-mono text-[10px] text-slate-400">{d.id ?? d.name} · branch {d.branchId.slice(0, 10)}…</div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create database"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button loading={creating} onClick={() => void createDatabase()} disabled={!newName.trim()}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label>Database name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="analytics" className="font-mono" />
          </div>
          <div>
            <Label>Owner role (defaults to neondb_owner)</Label>
            <Input value={newOwner} onChange={(e) => setNewOwner(e.target.value)} placeholder="neondb_owner" className="font-mono" />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete database ${deleteTarget?.name ?? ''}?`}
        message={
          <>This deletes the database and all of its data. Only this database is affected — the project and branch remain intact. Type the database name to confirm.</>
        }
        confirmText="Delete database"
        confirmDisabled={confirmText.trim() !== (deleteTarget?.name ?? '')}
        onConfirm={confirmDelete}
        onCancel={() => { setDeleteTarget(null); setConfirmText('') }}
      >
        <div className="mt-2">
          <Label>Type the database name to confirm</Label>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={deleteTarget?.name ?? ''} autoComplete="off" />
        </div>
      </ConfirmDialog>

      <Modal
        open={Boolean(attachTarget)}
        onClose={() => setAttachTarget(null)}
        title={`Connect to ${attachTarget?.name ?? ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAttachTarget(null)}>Cancel</Button>
            <Button
              loading={attaching === attachTarget?.name}
              disabled={!selectedRole || rolesState !== 'ready'}
              onClick={() => void attachDatabase()}
            >
              <Plug className="h-3.5 w-3.5" /> Connect
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
            The dashboard asks Neon for a connection URI for the database and role you pick. The
            credential stays on the server; permissions come from the role you choose here.
          </p>
          <div>
            <Label>Role</Label>
            {rolesState === 'loading' && <Skeleton className="h-9 w-full" />}
            {rolesState === 'error' && (
              <div className="space-y-2">
                <p className="text-[12.5px] text-rose-600 dark:text-rose-400">{rolesError}</p>
                <Button size="sm" variant="secondary" onClick={() => attachTarget && void openAttach(attachTarget)}>Retry</Button>
              </div>
            )}
            {rolesState === 'ready' && roles.length === 0 && (
              <EmptyState title="No roles on this branch" description="Create a role in the Neon console, then retry." />
            )}
            {rolesState === 'ready' && roles.length > 0 && (
              <>
                <Select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value)}>
                  <option value="" disabled>Choose a role</option>
                  {roles.map((r) => {
                    const unusable = Boolean(r.authenticationMethod && r.authenticationMethod !== 'password')
                    return (
                      <option key={r.name} value={r.name} disabled={unusable}>
                        {r.name}
                        {unusable ? ` (${r.authenticationMethod} — no password)` : ''}
                        {r.protected ? ' (protected)' : ''}
                      </option>
                    )
                  })}
                </Select>
                <p className="mt-1 text-[11px] text-slate-400">
                  Roles without password authentication cannot open a SQL session. Reset a role's
                  password in the Neon console to make it usable.
                </p>
              </>
            )}
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(connInfo)} onClose={() => setConnInfo(null)} title="Connection info">
        {connInfo ? (
          <div className="space-y-2 text-sm">
            <Row label="Host" value={connInfo.host} mono />
            <Row label="Port" value={String(connInfo.port)} mono />
            <Row label="Database" value={connInfo.database} mono />
            <Row label="Role" value={connInfo.role} mono />
            <p className="pt-1 text-xs text-slate-400">
              Copy this into the database-URL connection screen using the password for {connInfo.role}. Passwords are never exposed here.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const url = `postgres://${connInfo.role}:<password>@${connInfo.host}:${connInfo.port}/${connInfo.database}`
                void navigator.clipboard?.writeText(url)
                setCopyText('Copied template')
                toast('success', 'Connection template copied')
              }}
            >
              <Copy className="h-3.5 w-3.5" /> {copyText || 'Copy template'}
            </Button>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-900/50">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <span className={`font-mono text-xs text-slate-800 dark:text-slate-200 ${mono ? 'break-all text-right' : ''}`}>{value}</span>
    </div>
  )
}