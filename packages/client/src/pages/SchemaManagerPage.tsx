import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { RoleInfo, GrantInfo } from '../lib/types'
import { Button, Card, Badge, EmptyState, Input, Select, Label, Modal, ConfirmDialog, Skeleton, Table } from '../components/ui'
import {
  Table2,
  Plus,
  Trash2,
  Eye,
  KeyRound,
  Link2,
  Layers,
  Users,
  ChevronRight,
  Play,
  X,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '../lib/cn'

interface DdlResult {
  sql?: string
  ok?: boolean
  preview?: boolean
  error?: string
}

/** Run a DDL operation with preview-first semantics. */
async function applySchema(path: string, body: Record<string, unknown>, preview: boolean): Promise<{ sql?: string; ok?: boolean }> {
  return api.post<DdlResult>(path, { ...body, preview })
}

function SqlPreview({ sql }: { sql: string }) {
  return (
    <div className="overflow-x-auto rounded-lg bg-slate-900 p-3 dark:bg-black/40">
      <pre className="font-mono text-[11px] leading-relaxed text-emerald-300">{sql}</pre>
    </div>
  )
}

function DestructiveNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  )
}

type ModalKind =
  | 'createTable'
  | 'addColumn'
  | 'renameColumn'
  | 'dropColumn'
  | 'createIndex'
  | 'dropIndex'
  | 'createSchema'
  | 'createFk'
  | 'dropTable'

export function SchemaManagerPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const [tabs, setTabs] = useState<'ddl' | 'roles'>('ddl')
  const [tree, setTree] = useState<Array<{ name: string; objects: Array<{ name: string; kind: string }> }>>([])
  const [treeState, setTreeState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [open, setOpen] = useState<ModalKind | null>(null)
  const [previewSql, setPreviewSql] = useState<string | null>(null)
  const [previewTarget, setPreviewTarget] = useState<ModalKind | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingDestructive, setPendingDestructive] = useState<{ path: string; body: Record<string, unknown>; label: string } | null>(null)
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const [grants, setGrants] = useState<GrantInfo[]>([])
  const [rolesState, setRolesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [grantsFilter, setGrantsFilter] = useState('')

  const loadTree = useCallback(() => {
    setTreeState('loading')
    void api
      .get<{ tree: { schemas: Array<{ name: string; objects: Array<{ name: string; kind: string }> }> } }>('/api/data/tree')
      .then((r) => {
        setTree(r.tree.schemas)
        setTreeState('ready')
      })
      .catch((err) => {
        setTreeState('error')
        toast('error', err instanceof ApiError ? err.message : 'Could not load schema')
      })
  }, [toast])

  useEffect(() => loadTree(), [loadTree])

  function switchTab(t: 'ddl' | 'roles') {
    setTabs(t)
    if (t === 'roles') {
      setRolesState('loading')
      void api
        .get<{ roles: RoleInfo[] }>('/api/data/roles')
        .then((r) => {
          setRoles(r.roles)
          setRolesState('ready')
        })
        .catch((err) => {
          setRolesState('error')
          toast('error', err instanceof ApiError ? err.message : 'Could not load roles')
        })
      void api
        .get<{ grants: GrantInfo[] }>('/api/data/grants')
        .then((r) => {
          setGrants(r.grants)
        })
        .catch(() => undefined)
    }
  }

  async function preview(path: string, body: Record<string, unknown>, kind: ModalKind) {
    try {
      const r = await applySchema(path, body, true)
      setPreviewSql(r.sql ?? null)
      setPreviewTarget(kind)
    } catch (err) {
      toast('error', 'Preview failed', err instanceof ApiError ? err.message : '')
    }
  }

  async function apply(path: string, body: Record<string, unknown>, label: string, destructive?: boolean) {
    if (destructive) {
      setPendingDestructive({ path, body, label })
      setConfirmOpen(true)
      return
    }
    await runApply(path, body, label)
  }

  async function runApply(path: string, body: Record<string, unknown>, label: string) {
    try {
      await applySchema(path, body, false)
      toast('success', label)
      setOpen(null)
      setPreviewSql(null)
      setPreviewTarget(null)
      loadTree()
    } catch (err) {
      toast('error', `${label} failed`, err instanceof ApiError ? err.message : '')
    }
  }

  function confirmDestructive() {
    if (pendingDestructive) {
      void runApply(pendingDestructive.path, pendingDestructive.body, pendingDestructive.label)
    }
    setConfirmOpen(false)
    setPendingDestructive(null)
  }

  const readOnly = auth.connection?.metadata?.readOnly === true
  const accountOnly = auth.connection?.accountOnly === true

  if (accountOnly) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState title="Schema management needs a database connection" description="Connect with a database URL to create and alter tables, views and more." />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Schema Manager</h1>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-800">
          {(['ddl', 'roles'] as const).map((t) => (
            <button
              key={t}
              onClick={() => switchTab(t)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium capitalize',
                tabs === t ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300',
              )}
            >
              {t === 'ddl' ? 'Tables & Objects' : 'Roles & Grants'}
            </button>
          ))}
        </div>
        {readOnly && <Badge tone="amber">read-only</Badge>}
      </div>

      {tabs === 'ddl' && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setOpen('createTable')}>
              <Plus className="h-3.5 w-3.5" /> New table
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen('createSchema')}>
              <Layers className="h-3.5 w-3.5" /> New schema
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen('addColumn')}>
              <Plus className="h-3.5 w-3.5" /> Add column
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen('createIndex')}>
              <KeyRound className="h-3.5 w-3.5" /> Create index
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen('createFk')}>
              <Link2 className="h-3.5 w-3.5" /> Foreign key
            </Button>
          </div>

          <Card>
            <div className="prose-sm grid gap-1 p-3">
              {treeState === 'loading' && (
                <div className="space-y-2">
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-6 w-72" />
                </div>
              )}
              {treeState === 'error' && <p className="text-sm text-rose-500">Could not load schema tree.</p>}
              {treeState === 'ready' &&
                tree.map((s) => (
                  <div key={s.name}>
                    <div className="my-1 flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-200">
                      <ChevronRight className="h-3.5 w-3.5 text-slate-400" /> {s.name}
                    </div>
                    <div className="grid gap-1 pl-5 sm:grid-cols-2 lg:grid-cols-3">
                      {s.objects.map((o) => (
                        <div key={o.name} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5 text-xs dark:border-slate-700/50">
                          <Table2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          <span className="font-mono text-slate-700 dark:text-slate-200">{o.name}</span>
                          <Badge tone="slate">{o.kind}</Badge>
                          <div className="ml-auto flex items-center gap-0.5">
                            <ActionDrop
                              schema={s.name}
                              name={o.name}
                              kind={o.kind}
                              readOnly={readOnly}
                              onPreview={(body, modal) => void preview('/api/schema/tables', body, modal)}
                              onApply={(body, lbl, destr) => void apply('/api/schema/tables', body, lbl, destr)}
                            />
                            <button
                              onClick={() => {
                                void api
                                  .get<{ info: { schema: string; name: string; columns: Array<{ name: string; dataType: string; nullable: boolean; defaultValue: string | null; isPrimaryKey: boolean }> } }>('/api/data/table-info', {
                                    schema: s.name,
                                    table: o.name,
                                  })
                                  .then((r) =>
                                    toast('info', `${r.info.schema}.${r.info.name}`, r.info.columns.map((c) => `${c.name} ${c.dataType}`).join(', ').slice(0, 200)),
                                  )
                                  .catch(() => undefined)
                              }}
                              aria-label="Inspect table"
                              className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          </Card>

          <ActiveModal
            kind={open}
            tree={tree}
            readOnly={readOnly}
            onClose={() => setOpen(null)}
            onPreview={(path, body, kind) => void preview(path, body, kind)}
            onApply={apply}
          />
          {previewSql && (
            <Modal open onClose={() => { setPreviewSql(null); setPreviewTarget(null) }} title={`Generated SQL${previewTarget ? ` — ${previewTarget}` : ''}`}>
              <SqlPreview sql={previewSql} />
              <p className="mt-2 text-xs text-slate-400">Preview only — nothing was changed.</p>
              <div className="mt-3 flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => { setPreviewSql(null); setPreviewTarget(null) }}>
                  Close
                </Button>
              </div>
            </Modal>
          )}
          <ConfirmDialog
            open={confirmOpen}
            title={`Confirm ${pendingDestructive?.label ?? 'destructive operation'}`}
            message="This is destructive and affects the connected database. Dependents may be affected."
            confirmText="Apply"
            onConfirm={confirmDestructive}
            onCancel={() => { setConfirmOpen(false); setPendingDestructive(null) }}
          />
        </>
      )}

      {tabs === 'roles' && (
        <>
          {rolesState === 'loading' && <Skeleton className="h-40 w-full" />}
          {rolesState === 'error' && <EmptyState title="Roles unavailable" description="Your connected role may not be allowed to list roles. The dashboard only reports what PostgreSQL returns." />}
          {rolesState === 'ready' && (
            <div className="space-y-4">
              <Card className="p-4">
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                  <Users className="h-4 w-4 text-indigo-500" /> Roles
                </h3>
                <Table
                  headers={['Role', 'Attributes', 'Member of']}
                  rows={roles.map((r) => [
                    <span key="n" className="font-mono">{r.name}</span>,
                    <span key="a" className="flex flex-wrap gap-1">{r.attributes.map((a) => <Badge key={a} tone={a.toLowerCase().includes('super') || a.toLowerCase().includes('create') ? 'amber' : 'slate'}>{a}</Badge>)}</span>,
                    <span key="m" className="font-mono text-xs text-slate-400">{r.memberOf.join(', ') || '—'}</span>,
                  ])}
                />
              </Card>
              <Card className="p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Grants</h3>
                <div className="mb-2 max-w-xs">
                  <Input value={grantsFilter} onChange={(e) => setGrantsFilter(e.target.value)} placeholder="Filter grants…" />
                </div>
                <div className="max-h-96 overflow-auto">
                  <Table
                    headers={['Role', 'Schema', 'Object', 'Privilege', 'Grantable']}
                    rows={grants
                      .filter((g) => (grantsFilter ? `${g.role} ${g.schema ?? ''} ${g.objectName ?? ''} ${g.privilege}`.toLowerCase().includes(grantsFilter.toLowerCase()) : true))
                      .slice(0, 200)
                      .map((g) => [
                        <span key="r" className="font-mono">{g.role}</span>,
                        <span key="s" className="font-mono">{g.schema ?? '—'}</span>,
                        <span key="o" className="font-mono">{g.objectName ?? g.objectType ?? '—'}</span>,
                        <Badge key="p" tone="indigo">{g.privilege}</Badge>,
                        <span key="g">{g.grantable ? 'yes' : 'no'}</span>,
                      ])}
                  />
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ActionDrop({
  schema,
  name,
  kind,
  readOnly,
  onPreview,
  onApply,
}: {
  schema: string
  name: string
  kind: string
  readOnly: boolean
  onPreview: (body: Record<string, unknown>, modal: ModalKind) => void
  onApply: (body: Record<string, unknown>, label: string, destructive: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [cascade, setCascade] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={`Actions for ${name}`} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700">
        <Play className="h-3 w-3 -rotate-90" />
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-30 w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-800">
          <div className="mb-2 px-1 font-mono text-xs text-slate-500 dark:text-slate-400">{schema}.{name}</div>
          {kind === 'table' && (
            <label className="flex items-center gap-1.5 px-1 py-1 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} /> DROP CASCADE
            </label>
          )}
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700"
            onClick={() => {
              if (kind === 'table') {
                onPreview({ schema, name, cascade, confirm: false, preview: true }, 'dropTable')
              } else if (kind === 'index') {
                onPreview({ schema, name, confirm: false, preview: true }, 'dropIndex')
              } else {
                onPreview({ schema, name, confirm: false, preview: true }, 'dropColumn')
              }
              setOpen(false)
            }}
          >
            <Eye className="h-3.5 w-3.5" /> Preview drop
          </button>
          {!readOnly && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
              onClick={() => {
                if (kind === 'table') {
                  onApply({ schema, name, cascade, confirm: 'true' }, `Drop table ${schema}.${name}`, true)
                } else if (kind === 'index') {
                  onApply({ schema, name, confirm: 'true' }, `Drop index ${schema}.${name}`, true)
                } else {
                  onApply({ schema, name, confirm: 'true' }, `Drop ${kind} ${schema}.${name}`, true)
                }
                setOpen(false)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Drop
            </button>
          )}
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700" onClick={() => setOpen(false)}>
            <X className="h-3.5 w-3.5" /> Close
          </button>
        </div>
      )}
    </div>
  )
}

function ActiveModal({
  kind,
  tree,
  readOnly,
  onClose,
  onPreview,
  onApply,
}: {
  kind: ModalKind | null
  tree: Array<{ name: string; objects: Array<{ name: string; kind: string }> }>
  readOnly: boolean
  onClose: () => void
  onPreview: (path: string, body: Record<string, unknown>, kind: ModalKind) => void
  onApply: (path: string, body: Record<string, unknown>, label: string, destructive?: boolean) => void
}) {
  if (!kind) return null
  const common = { onClose, onPreview, onApply }
  switch (kind) {
    case 'createTable':
      return <CreateTableModal tree={tree} readOnly={readOnly} {...common} />
    case 'createSchema':
      return <CreateSchemaModal readOnly={readOnly} {...common} />
    case 'addColumn':
      return <AddColumnModal tree={tree} readOnly={readOnly} {...common} />
    case 'renameColumn':
      return <RenameColumnModal tree={tree} readOnly={readOnly} {...common} />
    case 'createIndex':
      return <CreateIndexModal tree={tree} readOnly={readOnly} {...common} />
    case 'createFk':
      return <CreateFkModal tree={tree} readOnly={readOnly} {...common} />
    case 'dropColumn':
      return <DropColumnModal tree={tree} readOnly={readOnly} {...common} />
    default:
      return null
  }
}

function SimpleModal({
  title,
  readOnly,
  onClose,
  children,
  onPreview,
  onApply,
  path,
  body,
  label,
}: {
  title: string
  readOnly: boolean
  onClose: () => void
  children: React.ReactNode
  onPreview: (path: string, body: Record<string, unknown>, kind: ModalKind) => void
  onApply: (path: string, body: Record<string, unknown>, label: string, destructive?: boolean) => void
  path: string
  body: Record<string, unknown>
  label: string
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={() => onPreview(path, body, 'createTable')}>
            <Eye className="h-3.5 w-3.5" /> Preview SQL
          </Button>
          {!readOnly && (
            <Button size="sm" onClick={() => onApply(path, body, label)}>
              Apply
            </Button>
          )}
        </>
      }
    >
      {children}
    </Modal>
  )
}

function CreateTableModal(props: {
  tree: Array<{ name: string; objects: Array<{ name: string; kind: string }> }>
  readOnly: boolean
  onClose: () => void
  onPreview: (path: string, body: Record<string, unknown>, kind: ModalKind) => void
  onApply: (path: string, body: Record<string, unknown>, label: string, destructive?: boolean) => void
}) {
  const [schema, setSchema] = useState(props.tree[0]?.name ?? 'public')
  const [name, setName] = useState('')
  const [cols, setCols] = useState([{ name: 'id', type: 'bigserial', nullable: false, primaryKey: true, default: '' }])
  const body = { schema, name, columns: cols.filter((c) => c.name).map((c) => ({ ...c, default: c.default || undefined })) }
  const { onClose, onPreview, onApply, readOnly } = props
  return (
    <SimpleModal title="Create table" readOnly={readOnly} onClose={onClose} onPreview={onPreview} onApply={onApply} path="/api/schema/tables" body={body} label="Table created">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Schema</Label>
            <Select value={schema} onChange={(e) => setSchema(e.target.value)}>
              {props.tree.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>Table name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="events" className="font-mono" />
          </div>
        </div>
        <div>
          <Label>Columns</Label>
          <div className="space-y-1.5">
            {cols.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input value={c.name} onChange={(e) => setCols((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="name" className="font-mono" />
                <Input value={c.type} onChange={(e) => setCols((cs) => cs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} placeholder="type" className="font-mono w-28" />
                <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                  <input type="checkbox" checked={!c.nullable} onChange={(e) => setCols((cs) => cs.map((x, j) => (j === i ? { ...x, nullable: !e.target.checked } : x)))} /> NN
                </label>
                <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                  <input type="checkbox" checked={c.primaryKey} onChange={(e) => setCols((cs) => cs.map((x, j) => (j === i ? { ...x, primaryKey: e.target.checked } : x)))} /> PK
                </label>
                {i > 0 && (
                  <button onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))} aria-label="Remove column" className="rounded p-1 text-rose-400 hover:bg-rose-50">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button className="mt-2 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setCols((cs) => [...cs, { name: '', type: 'text', nullable: true, primaryKey: false, default: '' }])}>
            + Add column
          </button>
        </div>
      </div>
    </SimpleModal>
  )
}

function CreateSchemaModal(props: { readOnly: boolean; onClose: () => void; onPreview: (p: string, b: Record<string, unknown>, k: ModalKind) => void; onApply: (p: string, b: Record<string, unknown>, l: string, d?: boolean) => void }) {
  const [name, setName] = useState('')
  const { onClose, onPreview, onApply, readOnly } = props
  return (
    <SimpleModal title="Create schema" readOnly={readOnly} onClose={onClose} onPreview={onPreview} onApply={onApply} path="/api/schema/create" body={{ name }} label="Schema created">
      <Label>Name</Label>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="analytics" className="font-mono" />
    </SimpleModal>
  )
}

function AddColumnModal(props: { tree: Array<{ name: string; objects: Array<{ name: string; kind: string }> }>; readOnly: boolean; onClose: () => void; onPreview: (p: string, b: Record<string, unknown>, k: ModalKind) => void; onApply: (p: string, b: Record<string, unknown>, l: string, d?: boolean) => void }) {
  const [schema, setSchema] = useState(props.tree[0]?.name ?? 'public')
  const [table, setTable] = useState('')
  const [column, setColumn] = useState('')
  const [type, setType] = useState('text')
  const [nullable, setNullable] = useState(true)
  const [defaultValue, setDefaultValue] = useState('')
  const { onClose, onPreview, onApply, readOnly } = props
  return (
    <SimpleModal title="Add column" readOnly={readOnly} onClose={onClose} onPreview={onPreview} onApply={onApply} path="/api/schema/columns" body={{ schema, table, column, type, nullable, default: defaultValue || undefined }} label="Column added">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Schema</Label>
            <Select value={schema} onChange={(e) => setSchema(e.target.value)}>{props.tree.map((s) => <option key={s.name}>{s.name}</option>)}</Select>
          </div>
          <div>
            <Label>Table</Label>
            <Select value={table} onChange={(e) => setTable(e.target.value)}>
              <option value="">select…</option>
              {props.tree.find((s) => s.name === schema)?.objects.filter((o) => o.kind === 'table').map((o) => <option key={o.name}>{o.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>Column name</Label>
            <Input value={column} onChange={(e) => setColumn(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label>Type</Label>
            <Input value={type} onChange={(e) => setType(e.target.value)} className="font-mono" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={!nullable} onChange={(e) => setNullable(!e.target.checked)} /> NOT NULL
        </label>
        <div>
          <Label>Default (raw SQL expression)</Label>
          <Input value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} placeholder="now()" className="font-mono" />
        </div>
      </div>
    </SimpleModal>
  )
}

function RenameColumnModal(props: { tree: Array<{ name: string; objects: Array<{ name: string; kind: string }> }>; readOnly: boolean; onClose: () => void; onPreview: (p: string, b: Record<string, unknown>, k: ModalKind) => void; onApply: (p: string, b: Record<string, unknown>, l: string, d?: boolean) => void }) {
  const [schema, setSchema] = useState(props.tree[0]?.name ?? 'public')
  const [table, setTable] = useState('')
  const [oldName, setOldName] = useState('')
  const [newName, setNewName] = useState('')
  const { onClose, onPreview, onApply, readOnly } = props
  return (
    <SimpleModal title="Rename column" readOnly={readOnly} onClose={onClose} onPreview={onPreview} onApply={onApply} path="/api/schema/columns/rename" body={{ schema, table, oldName, newName }} label="Column renamed">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Schema</Label>
            <Select value={schema} onChange={(e) => setSchema(e.target.value)}>{props.tree.map((s) => <option key={s.name}>{s.name}</option>)}</Select>
          </div>
          <div>
            <Label>Table</Label>
            <Select value={table} onChange={(e) => setTable(e.target.value)}>
              <option value="">select…</option>
              {props.tree.find((s) => s.name === schema)?.objects.filter((o) => o.kind === 'table').map((o) => <option key={o.name}>{o.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>Old name</Label>
            <Input value={oldName} onChange={(e) => setOldName(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label>New name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} className="font-mono" />
          </div>
        </div>
      </div>
    </SimpleModal>
  )
}

function CreateIndexModal(props: { tree: Array<{ name: string; objects: Array<{ name: string; kind: string }> }>; readOnly: boolean; onClose: () => void; onPreview: (p: string, b: Record<string, unknown>, k: ModalKind) => void; onApply: (p: string, b: Record<string, unknown>, l: string, d?: boolean) => void }) {
  const [schema, setSchema] = useState(props.tree[0]?.name ?? 'public')
  const [table, setTable] = useState('')
  const [name, setName] = useState('')
  const [columns, setColumns] = useState('')
  const [unique, setUnique] = useState(false)
  const [method, setMethod] = useState('btree')
  const { onClose, onPreview, onApply, readOnly } = props
  return (
    <SimpleModal title="Create index" readOnly={readOnly} onClose={onClose} onPreview={onPreview} onApply={onApply} path="/api/schema/indexes" body={{ schema, table, name, columns: columns.split(',').map((c) => c.trim()).filter(Boolean), unique, method }} label="Index created">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Schema</Label>
            <Select value={schema} onChange={(e) => setSchema(e.target.value)}>{props.tree.map((s) => <option key={s.name}>{s.name}</option>)}</Select>
          </div>
          <div>
            <Label>Table</Label>
            <Select value={table} onChange={(e) => setTable(e.target.value)}>
              <option value="">select…</option>
              {props.tree.find((s) => s.name === schema)?.objects.filter((o) => o.kind === 'table').map((o) => <option key={o.name}>{o.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>Index name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label>Columns (comma separated)</Label>
            <Input value={columns} onChange={(e) => setColumns(e.target.value)} placeholder="created_at, id" className="font-mono" />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> UNIQUE
          </label>
          <div className="w-28">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {['btree', 'hash', 'gin', 'gist', 'brin'].map((m) => <option key={m}>{m}</option>)}
            </Select>
          </div>
        </div>
      </div>
    </SimpleModal>
  )
}

function CreateFkModal(props: { tree: Array<{ name: string; objects: Array<{ name: string; kind: string }> }>; readOnly: boolean; onClose: () => void; onPreview: (p: string, b: Record<string, unknown>, k: ModalKind) => void; onApply: (p: string, b: Record<string, unknown>, l: string, d?: boolean) => void }) {
  const [schema, setSchema] = useState(props.tree[0]?.name ?? 'public')
  const [table, setTable] = useState('')
  const [name, setName] = useState('')
  const [column, setColumn] = useState('')
  const [referencedTable, setReferencedTable] = useState('')
  const [referencedColumn, setReferencedColumn] = useState('id')
  const [onDelete, setOnDelete] = useState('no action')
  const { onClose, onPreview, onApply, readOnly } = props
  return (
    <SimpleModal title="Add foreign key" readOnly={readOnly} onClose={onClose} onPreview={onPreview} onApply={onApply} path="/api/schema/foreign-keys" body={{ schema, table, name, column, referencedSchema: schema, referencedTable, referencedColumn, onDelete }} label="Foreign key added">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Schema</Label>
            <Select value={schema} onChange={(e) => setSchema(e.target.value)}>{props.tree.map((s) => <option key={s.name}>{s.name}</option>)}</Select>
          </div>
          <div>
            <Label>Table</Label>
            <Select value={table} onChange={(e) => setTable(e.target.value)}>
              <option value="">select…</option>
              {props.tree.find((s) => s.name === schema)?.objects.filter((o) => o.kind === 'table').map((o) => <option key={o.name}>{o.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>Constraint name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label>Local column</Label>
            <Input value={column} onChange={(e) => setColumn(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label>Referenced table</Label>
            <Select value={referencedTable} onChange={(e) => setReferencedTable(e.target.value)}>
              <option value="">select…</option>
              {props.tree.find((s) => s.name === schema)?.objects.filter((o) => o.kind === 'table').map((o) => <option key={o.name}>{o.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>Referenced column</Label>
            <Input value={referencedColumn} onChange={(e) => setReferencedColumn(e.target.value)} className="font-mono" />
          </div>
        </div>
        <div>
          <Label>ON DELETE</Label>
          <Select value={onDelete} onChange={(e) => setOnDelete(e.target.value)}>
            {['no action', 'restrict', 'cascade', 'set null', 'set default'].map((o) => <option key={o}>{o}</option>)}
          </Select>
        </div>
      </div>
    </SimpleModal>
  )
}

function DropColumnModal(props: { tree: Array<{ name: string; objects: Array<{ name: string; kind: string }> }>; readOnly: boolean; onClose: () => void; onPreview: (p: string, b: Record<string, unknown>, k: ModalKind) => void; onApply: (p: string, b: Record<string, unknown>, l: string, d?: boolean) => void }) {
  const [schema, setSchema] = useState(props.tree[0]?.name ?? 'public')
  const [table, setTable] = useState('')
  const [column, setColumn] = useState('')
  const { onClose, onPreview, onApply, readOnly } = props
  return (
    <SimpleModal
      title="Drop column"
      readOnly={readOnly}
      onClose={onClose}
      onPreview={onPreview}
      onApply={onApply}
      path="/api/schema/columns"
      body={{ schema, table, column, confirm: 'true' }}
      label={`Column ${column} dropped`}
    >
      <DestructiveNote>Dropping a column permanently removes data and cannot be undone. Views and indexes on it may break.</DestructiveNote>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Schema</Label>
            <Select value={schema} onChange={(e) => setSchema(e.target.value)}>{props.tree.map((s) => <option key={s.name}>{s.name}</option>)}</Select>
          </div>
          <div>
            <Label>Table</Label>
            <Select value={table} onChange={(e) => setTable(e.target.value)}>
              <option value="">select…</option>
              {props.tree.find((s) => s.name === schema)?.objects.filter((o) => o.kind === 'table').map((o) => <option key={o.name}>{o.name}</option>)}
            </Select>
          </div>
          <div className="col-span-2">
            <Label>Column to drop</Label>
            <Input value={column} onChange={(e) => setColumn(e.target.value)} className="font-mono" />
          </div>
        </div>
      </div>
    </SimpleModal>
  )
}