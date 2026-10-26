import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useToast } from '../contexts/ToastContext'
import { useAuth } from '../contexts/AuthContext'
import { useOnReconnect } from '../contexts/NetworkContext'
import { api, ApiError } from '../lib/api'
import { SchemaTree, TableInfo, RowPage } from '../lib/types'
import {
  Card,
  Skeleton,
  Badge,
  EmptyState,
  Button,
  Input,
  ConfirmDialog,
  Modal,
  Pagination,
  Label,
} from '../components/ui'
import {
  Table2,
  Eye,
  Link2,
  Search,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  ListFilter,
  X,
  KeyRound,
  RefreshCw,
} from 'lucide-react'
import { cn } from '../lib/cn'

export function DataBrowserPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const [params, setParams] = useSearchParams()
  const tableRef = params.get('table') ?? ''

  const [tree, setTree] = useState<SchemaTree | null>(null)
  const [treeState, setTreeState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [treeError, setTreeError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ public: true })

  const [info, setInfo] = useState<TableInfo | null>(null)
  const [page, setPage] = useState<RowPage | null>(null)
  const [infoState, setInfoState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [infoError, setInfoError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [orderBy, setOrderBy] = useState<string | undefined>(undefined)
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc')
  const [searchTerm, setSearchTerm] = useState('')
  const [searchInput, setSearchInput] = useState('')

  const [detailRow, setDetailRow] = useState<{ row: Record<string, unknown>; index: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [insertOpen, setInsertOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Record<string, unknown> | null>(null)
  const [mutating, setMutating] = useState(false)

  const readOnly = auth.connection?.metadata?.readOnly === true || auth.connection?.accountOnly === true

  const loadTree = useCallback(() => {
    setTreeState((prev) => (prev === 'ready' ? prev : 'loading'))
    api
      .get<{ tree: SchemaTree }>('/api/data/tree')
      .then((res) => {
        setTree(res.tree)
        setTreeState('ready')
      })
      .catch((err) => {
        setTreeState('error')
        setTreeError(err instanceof ApiError ? err.message : 'Could not load schema tree')
      })
  }, [])

  useEffect(loadTree, [loadTree])
  useOnReconnect(loadTree)

  const [schema, table] = tableRef.split('.')

  const loadTable = useCallback(async () => {
    if (!schema || !table) return
    setInfoState('loading')
    try {
      const [i, p] = await Promise.all([
        api.get<{ info: TableInfo }>('/api/data/table-info', { schema, table }),
        api.get<{ page: RowPage }>('/api/data/rows', {
          schema,
          table,
          offset,
          limit: pageSize,
          orderBy,
          orderDir,
          search: searchTerm || undefined,
        }),
      ])
      setInfo(i.info)
      setPage(p.page)
      setInfoState('ready')
    } catch (err) {
      setInfoState('error')
      setInfoError(err instanceof ApiError ? err.message : 'Could not load table')
    }
  }, [schema, table, offset, pageSize, orderBy, orderDir, searchTerm])

  useEffect(() => {
    if (tableRef) {
      setExpanded((e) => ({ ...e, [schema]: true }))
      void loadTable()
    }
  }, [tableRef, loadTable, schema])

  const identityColumns = useMemo(() => info?.primaryKeyColumns ?? [], [info])

  function makeIdentity(row: Record<string, unknown>): Record<string, unknown> {
    const id: Record<string, unknown> = {}
    const cols = identityColumns.length ? identityColumns : page?.columns ?? []
    for (const c of cols) id[c] = row[c]
    return id
  }

  async function performInsert(values: Record<string, unknown>) {
    if (!info) return
    setMutating(true)
    try {
      await api.post<{ result: unknown }>('/api/data/rows', {
        schema: info.schema,
        table: info.name,
        row: values,
      })
      toast('success', 'Row inserted', `${info.schema}.${info.name}`)
      setInsertOpen(false)
      void loadTable()
    } catch (err) {
      toast('error', 'Insert failed', err instanceof ApiError ? err.message : 'Unknown error')
    } finally {
      setMutating(false)
    }
  }

  async function performUpdate(values: Record<string, unknown>) {
    if (!info || !detailRow) return
    const identity = makeIdentity(detailRow.row)
    setMutating(true)
    try {
      await api.put<{ result: unknown }>('/api/data/rows', {
        schema: info.schema,
        table: info.name,
        identity,
        identityColumns: identityColumns.length ? identityColumns : page?.columns ?? [],
        changes: values,
      })
      toast('success', 'Row updated')
      setEditing(false)
      setDetailRow(null)
      void loadTable()
    } catch (err) {
      toast('error', 'Update failed', err instanceof ApiError ? err.message : 'Unknown error')
    } finally {
      setMutating(false)
    }
  }

  async function performDelete() {
    if (!info || !deleteTarget) return
    const identity = makeIdentity(deleteTarget)
    setMutating(true)
    try {
      await api.del<{ result: { rowCount: number | null } }>(
        '/api/data/rows',
        {
          schema: info.schema,
          table: info.name,
          confirm: true,
          identity,
          identityColumns: identityColumns.length ? identityColumns : page?.columns ?? [],
        },
        { confirm: 'true' },
      )
      toast('success', 'Row deleted')
      setDeleteTarget(null)
      setDetailRow(null)
      void loadTable()
    } catch (err) {
      toast('error', 'Delete failed', err instanceof ApiError ? err.message : 'Unknown error')
    } finally {
      setMutating(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[250px_1fr]">
      {/* Schema tree */}
      <Card className="h-fit lg:sticky lg:top-[4.5rem]">
        <div className="border-b border-slate-200 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400">
          Schema explorer
        </div>
        <div className="max-h-[calc(100vh-12rem)] overflow-y-auto p-2">
          {treeState === 'loading' && (
            <div className="space-y-2 p-1">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-4/5" />
              <Skeleton className="h-6 w-full" />
            </div>
          )}
          {treeState === 'error' && <EmptyState title="Schema unavailable" description={treeError} />}
          {treeState === 'ready' &&
            tree?.schemas.map((s) => {
              const isOpen = expanded[s.name]
              return (
                <div key={s.name} className="mb-0.5">
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [s.name]: !e[s.name] }))}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700/60"
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
                    <span className="flex-1 font-medium text-slate-700 dark:text-slate-200">{s.name}</span>
                    <span className="text-[10px] text-slate-400">{s.objects.length}</span>
                  </button>
                  {isOpen && (
                    <div className="ml-3 border-l border-slate-100 pl-2 dark:border-slate-700">
                      {s.objects.map((o) => (
                        <button
                          key={`${o.schema}.${o.name}`}
                          onClick={() => {
                            setParams({ table: `${o.schema}.${o.name}` })
                            setOffset(0)
                          }}
                          className={cn(
                            'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors',
                            tableRef === `${o.schema}.${o.name}`
                              ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700/60',
                          )}
                        >
                          {o.kind === 'view' || o.kind === 'materialized_view' ? (
                            <Eye className="h-3 w-3 shrink-0 text-sky-400" />
                          ) : o.kind === 'foreign_table' ? (
                            <Link2 className="h-3 w-3 shrink-0 text-amber-400" />
                          ) : (
                            <Table2 className="h-3 w-3 shrink-0 text-slate-400" />
                          )}
                          <span className="truncate">{o.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
        </div>
      </Card>

      {/* Table area */}
      <div className="min-w-0 space-y-4">
        {!tableRef && (
          <Card className="p-8">
            <EmptyState
              icon={<Table2 className="h-10 w-10" />}
              title="Select a table"
              description="Pick a table or view from the schema tree to browse columns, constraints and rows."
            />
          </Card>
        )}

        {infoState === 'loading' && (
          <div className="space-y-3">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        )}
        {infoState === 'error' && (
          <EmptyState icon={<Table2 className="h-10 w-10" />} title="Could not load table" description={infoError ?? ''} />
        )}

        {info && page && infoState === 'ready' && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-lg font-semibold text-slate-900 dark:text-slate-100">
                {info.schema}.{info.name}
              </h2>
              <Badge tone={info.kind === 'table' ? 'green' : info.kind === 'view' ? 'sky' : 'amber'}>{info.kind}</Badge>
              {info.rowEstimate != null && <Badge tone="slate">~{info.rowEstimate} rows</Badge>}
              {info.primaryKeyColumns.length > 0 && (
                <Badge tone="amber">
                  <KeyRound className="h-3 w-3" /> PK: {info.primaryKeyColumns.join(', ')}
                </Badge>
              )}
              <div className="ml-auto flex items-center gap-2">
                {!readOnly && (
                  <Button size="sm" onClick={() => setInsertOpen(true)}>
                    <Plus className="h-3.5 w-3.5" /> Insert row
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => void loadTable()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <Card className="p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Columns</h3>
              <div className="flex flex-wrap gap-1.5">
                {info.columns.map((col) => (
                  <span
                    key={col.name}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]',
                      col.isPrimaryKey
                        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                        : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300',
                    )}
                  >
                    {col.isPrimaryKey && <KeyRound className="h-3 w-3" />}
                    {col.name}
                    <span className="text-slate-400 dark:text-slate-500">{col.dataType}</span>
                    {!col.nullable && <span className="text-rose-400">NOT NULL</span>}
                    {col.defaultValue != null && <span className="text-emerald-500">DEFAULT {col.defaultValue}</span>}
                  </span>
                ))}
              </div>
              {info.indexes.length > 0 && (
                <div className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-700/60">
                  <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Indexes ({info.indexes.length})</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {info.indexes.map((idx) => (
                      <span
                        key={idx.name}
                        className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
                      >
                        {idx.unique && !idx.primary ? 'UNIQ ' : ''}
                        {idx.name}({idx.columns.join(', ')})
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <Input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && setSearchTerm(searchInput)}
                    placeholder="Search all columns (server-side)"
                    className="pl-8"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = pageSize === 50 ? 200 : pageSize === 200 ? 500 : 50
                    setPageSize(next)
                    setOffset(0)
                  }}
                >
                  <ListFilter className="h-3.5 w-3.5" /> {pageSize}/page
                </Button>
                {searchTerm && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSearchTerm('')
                      setSearchInput('')
                      setOffset(0)
                    }}
                  >
                    <X className="h-3.5 w-3.5" /> Clear
                  </Button>
                )}
              </div>

              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40">
                      {page.columns.map((col) => (
                        <th
                          key={col}
                          onClick={() => {
                            if (orderBy === col) setOrderDir((d) => (d === 'asc' ? 'desc' : 'asc'))
                            else {
                              setOrderBy(col)
                              setOrderDir('asc')
                            }
                            setOffset(0)
                          }}
                          className="cursor-pointer select-none whitespace-nowrap px-2.5 py-2 font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700/50"
                        >
                          <span className="flex items-center gap-1">
                            {identityColumns.includes(col) && <KeyRound className="h-3 w-3 text-amber-500" />}
                            {col}
                            {orderBy === col && <span className="text-[9px]">{orderDir === 'asc' ? '▲' : '▼'}</span>}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((row, i) => (
                      <tr
                        key={i}
                        onClick={() => setDetailRow({ row, index: offset + i })}
                        className="cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-indigo-50/40 dark:border-slate-700/40 dark:hover:bg-indigo-500/5"
                      >
                        {page.columns.map((col) => (
                          <td key={col} className="max-w-[280px] truncate whitespace-nowrap px-2.5 py-1.5 text-slate-700 dark:text-slate-200">
                            <CellValue value={row[col]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {page.rows.length === 0 && (
                  <div className="p-6 text-center text-sm text-slate-400">
                    No rows{searchTerm ? ' matching the search' : ' — this table is empty'}.
                  </div>
                )}
              </div>

              <div className="mt-2">
                <Pagination offset={offset} limit={pageSize} total={page.total} onPage={setOffset} />
              </div>
            </Card>
          </>
        )}
      </div>

      {/* Detail drawer */}
      {detailRow && (
        <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Row {detailRow.index + 1} — {info?.schema}.{info?.name}
            </h3>
            <button
              onClick={() => setDetailRow(null)}
              aria-label="Close detail"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {editing ? (
            <>
              <RowForm
                columns={info?.columns ?? []}
                initial={detailRow.row}
                submitLabel="Save changes"
                onSubmit={performUpdate}
                busy={mutating}
              />
              <div className="mt-3 flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel edit
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                {page?.columns.map((col) => (
                  <div key={col} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-900/50">
                    <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                      {identityColumns.includes(col) && <KeyRound className="h-2.5 w-2.5 text-amber-500" />}
                      {col}
                      <span className="ml-auto font-mono font-normal normal-case tracking-normal text-slate-400">
                        {info?.columns.find((c) => c.name === col)?.dataType}
                      </span>
                    </div>
                    <div className="mt-0.5 break-words font-mono text-xs text-slate-800 dark:text-slate-200">
                      {detailRow.row[col] === null || detailRow.row[col] === undefined ? (
                        <span className="italic text-slate-300 dark:text-slate-500">null</span>
                      ) : (
                        renderCell(detailRow.row[col])
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {!readOnly && (
                <div className="mt-4 flex gap-2">
                  <Button size="sm" className="flex-1" onClick={() => setEditing(true)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit row
                  </Button>
                  <Button size="sm" variant="danger" className="flex-1" onClick={() => setDeleteTarget(detailRow.row)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Insert modal */}
      <Modal open={insertOpen} onClose={() => setInsertOpen(false)} title={`Insert into ${info?.schema}.${info?.name ?? ''}`}>
        <RowForm columns={info?.columns ?? []} submitLabel="Insert row" onSubmit={performInsert} busy={mutating} />
      </Modal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete this row?"
        message="This permanently removes the row from the table and cannot be undone. The dashboard uses the primary key (or a full-row identity) to target exactly this row."
        confirmText="Delete row"
        onConfirm={() => void performDelete()}
        onCancel={() => setDeleteTarget(null)}
      >
        {identityColumns.length > 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Identity: {identityColumns.map((c) => `${c} = ${String(deleteTarget?.[c] ?? '')}`).join(', ')}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="italic text-slate-300 dark:text-slate-500">null</span>
  if (typeof value === 'object') return <span className="font-mono text-[10px] text-purple-600 dark:text-purple-300">{JSON.stringify(value)}</span>
  if (typeof value === 'boolean') return <Badge tone={value ? 'green' : 'slate'}>{String(value)}</Badge>
  return <span className="tnum">{String(value)}</span>
}

function renderCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return <span className="italic text-slate-300 dark:text-slate-500">null</span>
  if (typeof value === 'object') return <pre className="whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify(value, null, 2)}</pre>
  if (typeof value === 'boolean') return <Badge tone={value ? 'green' : 'slate'}>{String(value)}</Badge>
  return <span className="tnum break-words">{String(value)}</span>
}

/** Maps string inputs into basic typed values before sending to the server. */
function coerceValue(raw: string, dataType: string): unknown {
  if (dataType.toLowerCase().startsWith('bool')) return raw === 'true' || raw === '1' || raw === 'on'
  if (/^(int|serial|bigint|smallint|numeric|real|double|decimal)/i.test(dataType)) {
    if (raw.trim() === '') return null
    return Number(raw)
  }
  if (/^(json|jsonb)/i.test(dataType)) {
    if (raw.trim() === '') return null
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

function RowForm({
  columns,
  initial,
  submitLabel,
  onSubmit,
  busy,
}: {
  columns: TableInfo['columns']
  initial?: Record<string, unknown>
  submitLabel: string
  onSubmit: (values: Record<string, unknown>) => void
  busy?: boolean
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...(initial ?? {}) }))

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const cleaned: Record<string, unknown> = {}
        for (const col of columns) {
          const v = values[col.name]
          if (v === undefined || v === null || v === '') {
            if (col.nullable) continue
            cleaned[col.name] = v ?? null
          } else {
            cleaned[col.name] = v
          }
        }
        onSubmit(cleaned)
      }}
      className="space-y-3"
    >
      {columns.map((col) => (
        <div key={col.name}>
          <Label>
            <span className="flex items-center gap-1">
              {col.isPrimaryKey && <KeyRound className="h-3 w-3 text-amber-500" />}
              {col.name}
              {col.nullable ? '' : <span className="text-rose-500">*</span>}
            </span>
          </Label>
          <Input
            value={values[col.name] === undefined ? '' : String(values[col.name])}
            onChange={(e) => setValues((v) => ({ ...v, [col.name]: coerceValue(e.target.value, col.dataType) }))}
            placeholder={`${col.dataType}${col.defaultValue ? ` · default ${col.defaultValue}` : ''}`}
            className="font-mono text-xs"
            required={!col.nullable && !col.defaultValue}
          />
        </div>
      ))}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="submit" size="sm" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}