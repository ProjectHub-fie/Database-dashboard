import { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { EditorView } from '@codemirror/view'
import { useTheme } from '../contexts/ThemeContext'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { QueryResult, QueryHistoryEntry, SavedQuery } from '../lib/types'
import { Button, Card, Badge, EmptyState, Select, Input, Modal, Label, Spinner, ConfirmDialog } from '../components/ui'
import {
  Play,
  Plus,
  X,
  Square,
  History,
  Bookmark,
  Download,
  Copy,
  Save,
  Clock,
  AlertTriangle,
  Layers,
} from 'lucide-react'
import { cn } from '../lib/cn'

const DEFAULT_SQL = `-- Welcome to SQL Studio
-- Multi-line statements, Ctrl/Cmd+Enter to run.
SELECT version();`

interface Tab {
  id: string
  name: string
  sql: string
}

let tabSeq = 1

export function SqlStudioPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const { theme } = useTheme()

  const [tabs, setTabs] = useState<Tab[]>([{ id: 't0', name: 'Query 1', sql: DEFAULT_SQL }])
  const [activeId, setActiveId] = useState('t0')
  const [results, setResults] = useState<Record<string, QueryResult | undefined>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [confirmingSql, setConfirmingSql] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})

  const [timeoutMs, setTimeoutMs] = useState(30_000)
  const [maxRows, setMaxRows] = useState(1_000)
  const [transactionState, setTransactionState] = useState<string | null>(null)
  const [history, setHistory] = useState<QueryHistoryEntry[]>([])
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [showSaved, setShowSaved] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')

  const readOnly = auth.connection?.metadata?.readOnly === true
  const accountOnly = auth.connection?.accountOnly === true
  const canRun = !accountOnly

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!
  const activeResult = results[active.id]
  const activeError = errors[active.id]
  const activeRunning = running[active.id]


  useEffect(() => {
    api
      .get<{ history: QueryHistoryEntry[] }>('/api/sql/history', { limit: 50 })
      .then((r) => setHistory(r.history))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void api.get<{ saved: SavedQuery[] }>('/api/sql/saved').then((r) => setSaved(r.saved)).catch(() => undefined)
  }, [])

  function newTab() {
    const id = `t${Date.now()}`
    setTabs((ts) => [...ts, { id, name: `Query ${++tabSeq}`, sql: '' }])
    setActiveId(id)
  }

  function closeTab(id: string) {
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id)
      const next = ts.filter((t) => t.id !== id)
      if (id === activeId && next.length) {
        setActiveId(next[Math.max(0, Math.min(idx, next.length - 1))].id)
      }
      return next
    })
  }

  const activeSql = useMemo(() => active.sql, [active])

  async function run(confirmDestructive = false, sqlToRun = activeSql) {
    if (!canRun || running[active.id]) return
    setRunning((r) => ({ ...r, [active.id]: true }))
    setErrors((e) => ({ ...e, [active.id]: undefined }))
    try {
      const res = await api.post<{ result: QueryResult; durationMs: number }>('/api/sql/run', {
        sql: sqlToRun,
        statementTimeoutMs: timeoutMs,
        maxRows,
        confirmDestructive,
        transaction: transactionState ? { mode: transactionState as 'begin' | 'commit' | 'rollback' } : undefined,
      })
      setResults((m) => ({ ...m, [active.id]: res.result }))
      toast('success', 'Query completed', `${res.result.rowCount ?? 0} rows · ${res.result.durationMs} ms`)
      void api.get<{ history: QueryHistoryEntry[] }>('/api/sql/history', { limit: 50 }).then((r) => setHistory(r.history))
    } catch (err) {
      // The server refuses statements that change data or structure until the
      // operator acknowledges them; re-submit only after an explicit confirm.
      if (err instanceof ApiError && err.code === 'CONFIRMATION_REQUIRED') {
        setConfirmingSql(sqlToRun)
        return
      }
      const msg = err instanceof ApiError ? err.message : 'Query failed'
      setErrors((e) => ({ ...e, [active.id]: msg }))
      toast('error', msg)
    } finally {
      setRunning((r) => ({ ...r, [active.id]: false }))
    }
  }

  async function cancel() {
    try {
      await api.post('/api/sql/cancel', {})
      toast('info', 'Cancellation requested')
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Cancel failed')
    }
  }

  async function txAction(mode: 'begin' | 'commit' | 'rollback') {
    try {
      const res = await api.post<{ event?: string; ok?: boolean }>('/api/sql/run', {
        sql: `-- ${mode} transaction`,
        transaction: { mode },
      })
      if (mode === 'begin') setTransactionState('open')
      else setTransactionState(null)
      toast('success', `${mode} succeeded`)
      void res
    } catch (err) {
      toast('error', `${mode} failed`, err instanceof ApiError ? err.message : '')
    }
  }

  async function saveQuery() {
    if (!saveName.trim()) return
    try {
      await api.post('/api/sql/saved', { name: saveName.trim(), sql: activeSql })
      setSaveOpen(false)
      setSaveName('')
      toast('success', 'Query saved')
      const r = await api.get<{ saved: SavedQuery[] }>('/api/sql/saved')
      setSaved(r.saved)
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Save failed')
    }
  }

  async function loadSaved(q: SavedQuery) {
    const id = `t${Date.now()}`
    setTabs((ts) => [...ts, { id, name: q.name, sql: q.sql }])
    setActiveId(id)
  }

  async function deleteSaved(q: SavedQuery) {
    try {
      await api.del(`/api/sql/saved/${q.id}`, undefined)
      setSaved((s) => s.filter((x) => x.id !== q.id))
      toast('success', 'Saved query deleted')
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Delete failed')
    }
  }

  function exportResults(format: 'csv' | 'json') {
    if (!activeResult) return
    const cols = activeResult.columns.map((c) => c.name)
    let content: string
    let type: string
    if (format === 'csv') {
      type = 'text/csv'
      content = [cols, ...activeResult.rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')))].map((r) => r.join(',')).join('\n')
    } else {
      type = 'application/json'
      content = JSON.stringify(activeResult.rows, null, 2)
    }
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `query-${Date.now()}.${format}`
    a.click()
    URL.revokeObjectURL(url)
    toast('success', `Exported ${activeResult.rows.length} rows as ${format.toUpperCase()}`)
  }

  function copyResults() {
    if (!activeResult) return
    const cols = activeResult.columns.map((c) => c.name)
    const lines = [cols.join('\t'), ...activeResult.rows.map((r) => cols.map((c) => String(r[c] ?? '')).join('\t'))]
    void navigator.clipboard?.writeText(lines.join('\n'))
    toast('success', 'Copied to clipboard')
  }

  const isDestructive = /^\s*(drop|delete|truncate|alter|update|insert|create|grant|revoke)\b/i.test(activeSql)

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-7xl flex-col gap-3">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">SQL Studio</h1>
        {readOnly && <Badge tone="amber">read-only connection</Badge>}
        {transactionState === 'open' && (
          <Badge tone="indigo">
            <Layers className="h-3 w-3" /> transaction open
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={String(timeoutMs)}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
            className="w-32"
            aria-label="Statement timeout"
          >
            <option value={5000}>5s timeout</option>
            <option value={15000}>15s timeout</option>
            <option value={30000}>30s timeout</option>
            <option value={60000}>60s timeout</option>
            <option value={120000}>120s timeout</option>
          </Select>
          <Select value={String(maxRows)} onChange={(e) => setMaxRows(Number(e.target.value))} className="w-32" aria-label="Max rows">
            <option value={500}>500 rows</option>
            <option value={1000}>1,000 rows</option>
            <option value={5000}>5,000 rows</option>
            <option value={10000}>10,000 rows</option>
          </Select>
        </div>
      </div>

      {accountOnly ? (
        <Card className="p-8">
          <EmptyState
            title="SQL requires a database connection"
            description="Your current connection manages Neon resources via the API. Connect with a database URL to run queries."
          />
        </Card>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={cn(
                  'group flex max-w-[12rem] items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs',
                  t.id === activeId
                    ? 'border-indigo-300 bg-indigo-50 font-medium text-indigo-700 dark:border-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700/60',
                )}
              >
                <span className="truncate">{t.name}</span>
                <button onClick={() => closeTab(t.id)} aria-label="Close tab" className="rounded p-0.5 opacity-60 hover:bg-slate-200 hover:opacity-100 dark:hover:bg-slate-600">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button onClick={newTab} aria-label="New tab" className="rounded-lg border border-dashed border-slate-300 p-1.5 text-slate-400 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700">
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {/* Editor */}
          <Card className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col p-1">
              <CodeMirror
                value={activeSql}
                height="100%"
                extensions={[sql(), EditorView.lineWrapping]}
                theme={theme === 'dark' ? 'dark' : 'light'}
                onChange={(v) =>
                  setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, sql: v } : t)))
                }
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void run()
                  }
                }}
                className="h-full overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700"
              />
            </div>
            <div className="flex items-center gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-700">
              <Button size="sm" onClick={() => void run()} loading={activeRunning}>
                <Play className="h-3.5 w-3.5" /> Run {isDestructive && <span className="text-amber-300">(write)</span>}
              </Button>
              {activeRunning && (
                <Button size="sm" variant="secondary" onClick={() => void cancel()}>
                  <Square className="h-3 w-3" /> Cancel
                </Button>
              )}
              <div className="ml-1 flex items-center gap-1">
                <Button size="sm" variant={transactionState ? 'ghost' : 'secondary'} disabled={transactionState === 'open'} onClick={() => void txAction('begin')}>
                  BEGIN
                </Button>
                <Button size="sm" variant="secondary" disabled={transactionState !== 'open'} onClick={() => void txAction('commit')}>
                  COMMIT
                </Button>
                <Button size="sm" variant="secondary" disabled={transactionState !== 'open'} onClick={() => void txAction('rollback')}>
                  ROLLBACK
                </Button>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setSaveOpen(true)}>
                  <Save className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowSaved((s) => !s)}>
                  <Bookmark className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            {isDestructive && (
              <p className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                This statement modifies data or database structure. Make sure you intend to change the connected database.
              </p>
            )}
          </Card>

          {/* Results / history / saved */}
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {showSaved && (
              <Card className="p-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Saved queries</h3>
                {saved.length === 0 ? (
                  <p className="text-sm text-slate-400">No saved queries yet.</p>
                ) : (
                  <div className="space-y-1">
                    {saved.map((q) => (
                      <div key={q.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                        <button onClick={() => void loadSaved(q)} className="flex-1 truncate text-left text-sm text-slate-700 dark:text-slate-200">
                          {q.name}
                          <span className="ml-2 font-mono text-[10px] text-slate-400">{q.sql.slice(0, 40)}</span>
                        </button>
                        <button onClick={() => void deleteSaved(q)} aria-label={`Delete ${q.name}`} className="rounded p-1 text-slate-300 hover:text-rose-500">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[1fr_300px]">
              {/* Results */}
              <Card className="flex min-h-0 flex-col overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-700">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Results</span>
                  {activeResult && (
                    <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <Clock className="h-3 w-3" /> {activeResult.durationMs} ms · {activeResult.rowCount ?? 0} rows
                      {activeResult.truncated && ' · truncated'}
                      <button onClick={copyResults} aria-label="Copy results" className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-700">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => exportResults('csv')} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-700" title="Export CSV">
                        <Download className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => exportResults('json')} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-700" title="Export JSON">
                        <Download className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {activeError ? (
                    <div className="m-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                      {activeError}
                    </div>
                  ) : activeResult && activeResult.columns.length > 0 ? (
                    <ResultGrid result={activeResult} />
                  ) : activeRunning ? (
                    <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
                      <Spinner /> Running…
                    </div>
                  ) : (
                    <EmptyState title="Run a query to see results" description="Results appear here with row count and duration." />
                  )}
                </div>
              </Card>

              {/* History */}
              <Card className="flex max-h-96 min-h-0 flex-col xl:max-h-none">
                <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
                  <History className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">History</span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-2">
                  {history.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-slate-400">No queries in this session.</p>
                  ) : (
                    history.map((h) => (
                      <button
                        key={h.id}
                        onClick={() => {
                          const id = `t${Date.now()}`
                          setTabs((ts) => [...ts, { id, name: 'History', sql: h.sql }])
                          setActiveId(id)
                        }}
                        className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50"
                      >
                        <code className="block truncate font-mono text-[11px] text-slate-700 dark:text-slate-200">{h.sql}</code>
                        <span className={cn('text-[10px]', h.error ? 'text-rose-500' : 'text-slate-400')}>
                          {h.error ? 'error' : `${h.durationMs} ms · ${h.rowCount ?? 0} rows`}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </Card>
            </div>
          </div>

          {/* Save modal */}
          <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save query">
            <div className="space-y-3">
              <div>
                <Label>Name</Label>
                <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. Monthly active users" autoFocus />
              </div>
              <pre className="max-h-32 overflow-auto rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-600 dark:bg-slate-900/50 dark:text-slate-300">
                {activeSql}
              </pre>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setSaveOpen(false)}>Cancel</Button>
                <Button size="sm" onClick={() => void saveQuery()} disabled={!saveName.trim()}>Save</Button>
              </div>
            </div>
          </Modal>

          <ConfirmDialog
            open={confirmingSql !== null}
            title="Run a statement that changes data or structure?"
            message="This statement is not read-only. It may modify or delete data, or alter the schema, and the effect cannot always be undone. Confirm only if you understand the statement below."
            confirmText="Run statement"
            tone="danger"
            onConfirm={() => {
              const sqlToRun = confirmingSql
              setConfirmingSql(null)
              if (sqlToRun !== null) void run(true, sqlToRun)
            }}
            onCancel={() => setConfirmingSql(null)}
          >
            <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-slate-50 p-2 font-mono text-[11px] text-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
              {confirmingSql}
            </pre>
          </ConfirmDialog>
        </>
      )}
    </div>
  )
}

function ResultGrid({ result }: { result: QueryResult }) {
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900">
          <tr>
            <th className="w-10 px-2 py-1.5 text-right font-mono text-[10px] text-slate-400">#</th>
            {result.columns.map((c, i) => (
              <th key={i} className="whitespace-nowrap border-l border-slate-200 px-2.5 py-1.5 font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="border-t border-slate-100 dark:border-slate-700/40">
              <td className="px-2 py-1.5 text-right font-mono text-[10px] text-slate-400">{i + 1}</td>
              {result.columns.map((c, j) => (
                <td key={j} className="max-w-[320px] truncate whitespace-nowrap border-l border-slate-100 px-2.5 py-1.5 text-slate-700 dark:border-slate-700/40 dark:text-slate-200">
                  <ResultCell value={row[c.name]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length === 0 && (
        <div className="p-6 text-center text-sm text-slate-400">
          {result.rowCount === 0 ? 'Query returned 0 rows' : 'No rows returned'}
        </div>
      )}
    </div>
  )
}

function ResultCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="italic text-slate-300 dark:text-slate-500">null</span>
  if (typeof value === 'object') return <span className="font-mono text-[10px] text-purple-600 dark:text-purple-300">{JSON.stringify(value)}</span>
  if (typeof value === 'boolean') return <span>{String(value)}</span>
  return <span className="tnum">{String(value)}</span>
}