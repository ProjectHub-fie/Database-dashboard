import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useOnReconnect } from '../contexts/NetworkContext'
import { useToast } from '../contexts/ToastContext'
import { api, ApiError } from '../lib/api'
import { SchemaObjectSummary, TableInfo } from '../lib/types'
import { Button, Card, Badge, EmptyState, Label, Select } from '../components/ui'
import { ArrowUpDown, Upload, Download, AlertTriangle, FileJson, FileText, CheckCircle2 } from 'lucide-react'
import { capabilitiesOf } from '../lib/capabilities'

export function ImportExportPage() {
  const auth = useAuth()
  const { toast } = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<'import' | 'export'>('import')
  const [tables, setTables] = useState<SchemaObjectSummary[]>([])
  const [schema, setSchema] = useState('public')
  const [table, setTable] = useState('')
  const [info, setInfo] = useState<TableInfo | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')

  const [fileName, setFileName] = useState('')
  const [fileRows, setFileRows] = useState<Array<Array<unknown>>>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<number, string>>({})
  const [batchSize, setBatchSize] = useState(200)
  const [transactional, setTransactional] = useState(true)
  const [previewMode, setPreviewMode] = useState<'idle' | 'preview' | 'validated'>('idle')
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null)
  const [importResult, setImportResult] = useState<{ inserted: number; failed: number; errors: Array<{ row: number; message: string }> } | null>(null)

  const readOnly = auth.connection?.metadata?.readOnly === true
  const accountOnly = auth.connection?.accountOnly === true
  const capabilities = capabilitiesOf(auth.connection)
  const canImport = capabilities.includes('data.import.csv')
  const canExport = capabilities.includes('data.export.csv')

  const loadTables = useCallback(async () => {
    setLoadState('loading')
    try {
      const r = await api.get<{ objects: SchemaObjectSummary[] }>('/api/data/tables')
      setTables(r.objects.filter((o) => o.kind === 'table'))
      const first = r.objects.find((o) => o.kind === 'table')
      if (first) {
        setSchema(first.schema)
        setTable(first.name)
      }
      setLoadState('ready')
    } catch {
      setLoadState('ready')
    }
  }, [])

  useEffect(() => {
    if (!accountOnly) void loadTables()
  }, [accountOnly, loadTables])
  useOnReconnect(() => void loadTables())

  useEffect(() => {
    if (!schema || !table) return
    void api
      .get<{ info: TableInfo }>('/api/data/table-info', { schema, table })
      .then((r) => setInfo(r.info))
      .catch(() => undefined)
  }, [schema, table])

  const validMapping = useMemo(() => {
    const used = Object.values(mapping).filter(Boolean)
    return used.length > 0 && used.length === new Set(used).size
  }, [mapping])

  function handleFile(file: File) {
    setFileName(file.name)
    setImportResult(null)
    setPreviewMode('idle')
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const lines = text.split(/\r?\n/).filter((_, i) => i < 5000)
      if (lines.length === 0) {
        toast('error', 'Empty file')
        return
      }
      const rows = lines.map((l) => splitCsv(l))
      setHeaders(rows[0] ?? [])
      const dataRows = rows.slice(1).filter((r) => r.length > 0 && r.some((c) => c.trim() !== ''))
      setFileRows(dataRows)
      // Auto-map by column name
      const auto: Record<number, string> = {}
      info?.columns.forEach((c) => {
        const idx = (rows[0] ?? []).findIndex((h) => h.trim().toLowerCase() === c.name.toLowerCase())
        if (idx >= 0) auto[idx] = c.name
      })
      setMapping(auto)
      setPreviewMode('preview')
    }
    reader.readAsText(file)
  }

  function splitCsv(line: string): string[] {
    const out: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = !inQ
      } else if (ch === ',' && !inQ) {
        out.push(cur)
        cur = ''
      } else cur += ch
    }
    out.push(cur)
    return out.map((c) => c.trim())
  }

  async function runImport() {
    if (!validMapping) return
    const cols = Object.entries(mapping)
      .filter(([, v]) => v)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
    const rows = fileRows.map((r) => cols.map(([i]) => r[Number(i)] ?? null))
    setImporting(true)
    try {
      const res = await api.post<{ inserted: number; failed: number; errors: Array<{ row: number; message: string }> }>('/api/data/import', {
        schema,
        table,
        columns: cols.map(([, v]) => v),
        rows,
        batchSize,
        transactional,
      })
      setImportResult(res)
      setPreviewMode('validated')
      if (res.failed === 0) toast('success', `Imported ${res.inserted} rows`)
    } catch (err) {
      toast('error', 'Import failed', err instanceof ApiError ? err.message : '')
    } finally {
      setImporting(false)
    }
  }

  function exportFormat(fmt: 'csv' | 'json') {
    if (!info || exporting) return
    setExporting(fmt)
    // The row cap is enforced server-side (the browser UI's 500/page limit
    // used to 400 every export request). The response headers report whether
    // the cap was actually reached, so the toast can be honest about it.
    api
      .getBlob<{ exported: number; truncated: boolean; limit: number }>('/api/data/export', {
        schema,
        table,
        format: fmt,
        limit: 10_000,
      })
      .then(({ blob, meta }) => {
        downloadBlob(blob, `${table}.${fmt}`)
        toast('success', `Exported ${meta.exported} rows`, meta.truncated ? `truncated at ${meta.limit} rows — refine by table filter or use SQL Studio` : '')
      })
      .catch((err) => toast('error', err instanceof ApiError ? err.message : 'Export failed'))
      .finally(() => setExporting(null))
  }

  const exportCsv = () => exportFormat('csv')
  const exportJson = () => exportFormat('json')

  if (accountOnly) {
    return <EmptyState icon={<ArrowUpDown className="h-10 w-10" />} title="Import/Export needs a database connection" description="Connect with a database URL to import and export table data." />
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Import / Export</h1>
        {readOnly && <Badge tone="amber">read-only — imports disabled</Badge>}
      </div>

      <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-800">
        {(['import', 'export'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${tab === t ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
          >
            {t}
          </button>
        ))}
      </div>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Schema</Label>
            <Select value={schema} onChange={(e) => setSchema(e.target.value)}>
              {[...new Set(tables.map((t) => t.schema))].map((s) => <option key={s}>{s}</option>)}
            </Select>
          </div>
          <div>
            <Label>Table</Label>
            <Select value={table} onChange={(e) => setTable(e.target.value)}>
              {tables.filter((t) => t.schema === schema).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </Select>
          </div>
        </div>
        {info && (
          <p className="mt-2 text-xs text-slate-400">
            {info.schema}.{info.name} — {info.columns.length} columns
            {info.columns.some((c) => c.isPrimaryKey) ? ' · primary key present' : ' · no primary key'}
          </p>
        )}
      </Card>

      {tab === 'import' ? (
        <Card className="p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            <Upload className="h-4 w-4 text-indigo-500" /> CSV import
          </h2>

          {!readOnly && canImport && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
              <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()} disabled={!table || loadState === 'loading'}>
                Choose CSV file (max 25 MB)
              </Button>
              {fileName && <span className="ml-2 text-xs text-slate-400">{fileName}</span>}
            </>
          )}

          {previewMode !== 'idle' && fileRows.length > 0 && (
            <div className="mt-4 space-y-4">
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40">
                      <th className="px-2 py-1.5 text-slate-400">#</th>
                      {headers.map((h, i) => (
                        <th key={i} className="whitespace-nowrap px-2 py-1.5 text-slate-600 dark:text-slate-300">
                          <div className="underline decoration-dotted">{h}</div>
                          <select
                            className="mt-1 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] dark:border-slate-600 dark:bg-slate-700"
                            value={mapping[i] ?? ''}
                            onChange={(e) => setMapping((m) => ({ ...m, [i]: e.target.value }))}
                          >
                            <option value="">— skip —</option>
                            {info?.columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.dataType})</option>)}
                          </select>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fileRows.slice(0, 5).map((r, ri) => (
                      <tr key={ri}>
                        <td className="px-2 py-1 font-mono text-slate-400">{ri + 1}</td>
                        {r.map((c, ci) => <td key={ci} className="max-w-[160px] truncate whitespace-nowrap px-2 py-1 font-mono text-slate-700 dark:text-slate-200">{c === null || c === '' ? <i className="text-slate-300 dark:text-slate-500">null</i> : String(c)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center gap-4 rounded-lg bg-slate-50 p-3 dark:bg-slate-900/50">
                <div>
                  <Label>Batch size</Label>
                  <Select value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} className="w-28">
                    {[50, 100, 200, 500].map((b) => <option key={b} value={b}>{b}</option>)}
                  </Select>
                </div>
                <label className="flex items-center gap-2 pt-4 text-xs text-slate-600 dark:text-slate-300">
                  <input type="checkbox" checked={transactional} onChange={(e) => setTransactional(e.target.checked)} />
                  Transactional (rolls back all rows if any fail)
                </label>
                <div className="ml-auto pt-4">
                  <Button size="sm" onClick={() => void runImport()} disabled={!validMapping} loading={importing}>
                    Import {fileRows.length} rows
                  </Button>
                </div>
              </div>
              {!validMapping && <p className="text-xs text-amber-600">Map at least one unique target column. Duplicate targets are not allowed.</p>}
            </div>
          )}

          {previewMode === 'validated' && importResult && (
            <div className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${importResult.failed === 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'}`}>
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Inserted {importResult.inserted} rows, {importResult.failed} failed.
                {importResult.failed > 0 && ` ${importResult.errors.map((e) => `row ${e.row}: ${e.message}`).slice(0, 5).join('; ')}`}
              </span>
            </div>
          )}

          {readOnly && <p className="mt-2 text-sm text-slate-400">The connected role is read-only. Imports are disabled.</p>}
          {!canImport && !readOnly && <p className="mt-2 text-sm text-slate-400">CSV import is not available on this connection.</p>}
        </Card>
      ) : (
        <Card className="p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            <Download className="h-4 w-4 text-emerald-500" /> Export table data
          </h2>
          {canExport ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={exportCsv} disabled={exporting !== null} loading={exporting === 'csv'}>
                <FileText className="h-3.5 w-3.5" /> {exporting === 'csv' ? 'Preparing…' : 'Export CSV'}
              </Button>
              <Button size="sm" variant="secondary" onClick={exportJson} disabled={exporting !== null} loading={exporting === 'json'}>
                <FileJson className="h-3.5 w-3.5" /> {exporting === 'json' ? 'Preparing…' : 'Export JSON'}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-slate-400">Export is not available on this connection.</p>
          )}
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Exports stream up to 10,000 rows from the live database. A CSV export is <strong>not</strong> a Neon backup — for provider-level backups use Neon's point-in-time restore and branched storage.
          </p>
        </Card>
      )}

    </div>
  )
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}