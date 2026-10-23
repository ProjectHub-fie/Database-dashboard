import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { Project, Organization, ProviderOperation } from '../lib/types'
import { Button, Card, Badge, EmptyState, Input, Label, Select, Modal, ConfirmDialog, Skeleton } from '../components/ui'
import { FolderOpen, Plus, Globe2, MapPin, Trash2, Clock } from 'lucide-react'

export function ProjectsPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const nav = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [orgId, setOrgId] = useState<string>('')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRegion, setNewRegion] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [busyOp, setBusyOp] = useState<ProviderOperation | null>(null)

  const accountOnly = auth.connection?.accountOnly === true
  const capabilities = auth.connection?.capabilities?.capabilities ?? []
  const canCreate = capabilities.includes('control.createProject')
  const canDelete = capabilities.includes('control.deleteProject')

  const load = useCallback(
    async (selectedOrg?: string) => {
      setState('loading')
      try {
        const q: Record<string, string | undefined> = selectedOrg ? { orgId: selectedOrg } : {}
        const [p, o] = await Promise.all([
          api.get<{ projects: Project[] }>('/api/control/projects', q),
          api.get<{ organizations: Organization[] }>('/api/control/organizations').catch(() => ({ organizations: [] })),
        ])
        setProjects(p.projects)
        setOrgs(o.organizations)
        setState('ready')
      } catch (err) {
        setState('error')
        setError(err instanceof ApiError ? err.message : 'Could not load projects')
      }
    },
    [],
  )

  useEffect(() => {
    if (accountOnly) void load(orgId || undefined)
  }, [accountOnly, load, orgId])

  async function createProject() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const res = await api.post<{ project: Project; operation: ProviderOperation }>('/api/control/projects', {
        name: newName.trim(),
        orgId: orgId || undefined,
        region: newRegion || undefined,
      })
      toast('success', `Project ${res.project.name} created`)
      if (res.operation?.id) setBusyOp(res.operation)
      setCreateOpen(false)
      setNewName('')
      void load(orgId || undefined)
      void waitOperation(res.operation)
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not create project')
    } finally {
      setCreating(false)
    }
  }

  async function waitOperation(op: ProviderOperation | undefined) {
    if (!op?.id) return
    const poll = window.setInterval(async () => {
      try {
        const r = await api.get<{ operation: ProviderOperation }>(
          `/api/control/projects/${op.projectId ?? ''}/operation/${op.id}`,
        )
        setBusyOp(r.operation)
        if (['finished', 'failed', 'error', 'cancelled'].includes(r.operation.status)) {
          window.clearInterval(poll)
          if (r.operation.status === 'finished') toast('success', 'Operation finished', r.operation.action)
          else toast('warning', 'Operation did not finish', r.operation.error)
        }
      } catch {
        window.clearInterval(poll)
      }
    }, 1500)
    return () => window.clearInterval(poll)
  }

  function confirmDelete() {
    if (!deleteTarget || confirmText.trim() !== deleteTarget.name) return
    setBusyOp(null)
    void api
      .del<{ operation: ProviderOperation }>(`/api/control/projects/${encodeURIComponent(deleteTarget.id)}`, undefined, {
        confirm: deleteTarget.id,
      })
      .then(async (res) => {
        toast('success', `Deleting project ${deleteTarget.name}`)
        setDeleteTarget(null)
        setConfirmText('')
        setBusyOp(res.operation)
        await waitOperation(res.operation)
        void load(orgId || undefined)
      })
      .catch((err) => toast('error', err instanceof ApiError ? err.message : 'Delete failed'))
  }

  if (!accountOnly) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title="Projects require API mode"
          description="Use the connection screen to connect with a Neon API key. Database-URL connections intentionally cannot list or manage your other Neon projects."
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Projects</h1>
        <div className="ml-auto flex items-center gap-2">
          {orgs.length > 0 && (
            <div className="w-56">
              <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                <option value="">All organizations</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </div>
          )}
          {canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New project
            </Button>
          )}
        </div>
      </div>

      {busyOp && (
        <div className="flex items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Clock className="h-4 w-4 animate-spin" /> {busyOp.action}: {busyOp.status}
          {busyOp.id && <span className="font-mono text-xs opacity-70">{busyOp.id.slice(0, 8)}</span>}
        </div>
      )}

      {state === 'loading' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}
      {state === 'error' && <EmptyState title="Could not load projects" description={error} />}
      {state === 'ready' && projects.length === 0 && (
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title="No projects"
          description="Projects returned by the Neon API appear here. Create one to get started."
          action={canCreate ? <Button onClick={() => setCreateOpen(true)}><Plus className="h-3.5 w-3.5" /> New project</Button> : undefined}
        />
      )}
      {state === 'ready' && projects.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</span>
                    {p.platformId && <span className="font-mono text-[10px] text-slate-400">{p.platformId}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {p.region && (
                      <Badge tone="sky">
                        <MapPin className="h-3 w-3" /> {p.region}
                      </Badge>
                    )}
                    <span className="font-mono text-[10px] text-slate-400">{p.id.slice(0, 10)}…</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => nav(`/databases?project=${encodeURIComponent(p.id)}`)}
                    className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600 dark:hover:bg-slate-700"
                    title="Open project"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </button>
                  {canDelete && (
                    <button
                      onClick={() => { setDeleteTarget(p); setConfirmText('') }}
                      className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                      title="Delete project"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                <Clock className="h-3 w-3" /> created {p.createdAt ? new Date(p.createdAt).toLocaleString() : '—'}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create Neon project"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button loading={creating} onClick={() => void createProject()} disabled={!newName.trim()}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-app-db" />
          </div>
          <div>
            <Label>Region</Label>
            <Input value={newRegion} onChange={(e) => setNewRegion(e.target.value)} placeholder="aws-us-east-2 (optional)" />
          </div>
          {orgs.length > 0 && (
            <div>
              <Label>Organization</Label>
              <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                <option value="">Personal / default</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </div>
          )}
          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <Globe2 className="h-3.5 w-3.5" /> Creating a project also creates its primary branch and default database on Neon.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete project ${deleteTarget?.name ?? ''}?`}
        message={
          <span>
            This deletes the <strong>entire Neon project</strong> — all branches, databases, roles and data. Type the project name to confirm.
          </span>
        }
        confirmText="Delete project"
        confirmDisabled={confirmText.trim() !== (deleteTarget?.name ?? '')}
        onConfirm={confirmDelete}
        onCancel={() => { setDeleteTarget(null); setConfirmText('') }}
      >
        <div className="mt-2">
          <Label>Type project name to confirm</Label>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={deleteTarget?.name ?? 'project name'}
            autoComplete="off"
          />
        </div>
      </ConfirmDialog>
    </div>
  )
}