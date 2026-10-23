import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { Project, Branch, ProviderOperation } from '../lib/types'
import { Button, Card, Badge, EmptyState, Input, Label, Select, Modal, ConfirmDialog, Skeleton } from '../components/ui'
import { GitBranch, Plus, Trash2, Clock, Star } from 'lucide-react'

export function BranchesPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const [params] = useSearchParams()
  const projectId = params.get('project') ?? ''

  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState(projectId)
  const [branches, setBranches] = useState<Branch[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [parentId, setParentId] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Branch | null>(null)
  const [confirmText, setConfirmText] = useState('')

  const capabilities = auth.connection?.capabilities?.capabilities ?? []
  const canCreate = capabilities.includes('control.createBranch')
  const canDelete = capabilities.includes('control.deleteBranch')

  useEffect(() => {
    void api.get<{ projects: Project[] }>('/api/control/projects').then((r) => {
      setProjects(r.projects)
      if (!selectedProject && r.projects[0]) setSelectedProject(r.projects[0].id)
    }).catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    if (!selectedProject) {
      setState('ready')
      return
    }
    setState('loading')
    try {
      const r = await api.get<{ branches: Branch[] }>(`/api/control/projects/${encodeURIComponent(selectedProject)}/branches`)
      setBranches(r.branches)
      setState('ready')
    } catch (err) {
      setState('error')
      setError(err instanceof ApiError ? err.message : 'Could not load branches')
    }
  }, [selectedProject])

  useEffect(() => {
    void load()
  }, [load])

  async function createBranch() {
    if (!selectedProject) return
    setCreating(true)
    try {
      const res = await api.post<{ branch: Branch; operation?: ProviderOperation }>(
        `/api/control/projects/${encodeURIComponent(selectedProject)}/branches`,
        { name: newName.trim() || undefined, parentId: parentId || undefined },
      )
      toast('success', `Branch ${res.branch.name} created`)
      setCreateOpen(false)
      setNewName('')
      void load()
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not create branch')
    } finally {
      setCreating(false)
    }
  }

  function confirmDelete() {
    if (!deleteTarget || confirmText.trim() !== deleteTarget.id) return
    void api
      .del<{ operation?: ProviderOperation }>(
        `/api/control/projects/${encodeURIComponent(deleteTarget.projectId)}/branches/${encodeURIComponent(deleteTarget.id)}`,
        undefined,
        { confirm: deleteTarget.id },
      )
      .then(() => {
        toast('success', `Branch ${deleteTarget.name} deletion initiated`)
        setDeleteTarget(null)
        setConfirmText('')
        void load()
      })
      .catch((err) => toast('error', err instanceof ApiError ? err.message : 'Delete failed'))
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Branches</h1>
        <div className="ml-auto flex items-center gap-2">
          <div className="w-72">
            <Select value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          {canCreate && (
            <Button size="sm" onClick={() => { setCreateOpen(true); setParentId('') }}>
              <Plus className="h-3.5 w-3.5" /> New branch
            </Button>
          )}
        </div>
      </div>

      {state === 'loading' && <Skeleton className="h-32 w-full" />}
      {state === 'error' && <EmptyState title="Could not load branches" description={error} />}
      {state === 'ready' && branches.length === 0 && (
        <EmptyState icon={<GitBranch className="h-10 w-10" />} title="No branches" description="Select a project or create a branch." />
      )}
      {state === 'ready' && branches.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {branches.map((b) => (
            <Card key={b.id} className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-indigo-400" />
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{b.name}</span>
                  {b.primary && <Badge tone="indigo"><Star className="h-3 w-3" /> primary</Badge>}
                </div>
                {canDelete && !b.primary && (
                  <button
                    onClick={() => { setDeleteTarget(b); setConfirmText('') }}
                    className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                    title="Delete branch"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                <Clock className="h-3 w-3" /> created {b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}
                <span className="font-mono">{b.id.slice(0, 10)}…</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create branch"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button loading={creating} onClick={() => void createBranch()}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label>Branch name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="feature/analytics" />
          </div>
          {branches.length > 0 && (
            <div>
              <Label>Parent branch (defaults to primary)</Label>
              <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">Primary branch</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </div>
          )}
          <p className="text-xs text-slate-400">A branch is a fully isolated copy-on-write database derived from the parent.</p>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete branch ${deleteTarget?.name ?? ''}?`}
        message="This deletes the branch and its databases. Data that exists only on this branch is lost. Type the branch id to confirm."
        confirmText="Delete branch"
        confirmDisabled={confirmText.trim() !== (deleteTarget?.id ?? '')}
        onConfirm={confirmDelete}
        onCancel={() => { setDeleteTarget(null); setConfirmText('') }}
      >
        <div className="mt-2">
          <Label>Type the branch id to confirm</Label>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={deleteTarget?.id ?? ''} autoComplete="off" />
        </div>
      </ConfirmDialog>
    </div>
  )
}