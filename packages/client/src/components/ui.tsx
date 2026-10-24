import React, { ReactNode, useEffect, useRef, Component, ErrorInfo } from 'react'
import { Loader2, Inbox, ChevronLeft, ChevronRight, AlertTriangle, X } from 'lucide-react'
import { cn } from '../lib/cn'

// ---------------------------------------------------------------------------
// Design tokens / helpers
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-indigo-500', className)} />
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading,
  className,
  ...rest
}: {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary:
      'bg-slate-900 text-white hover:bg-slate-800 focus-visible:outline-slate-900 disabled:bg-slate-300 disabled:text-white dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 dark:disabled:bg-slate-700 dark:disabled:text-slate-400',
    secondary:
      'border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800',
    ghost:
      'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
    danger:
      'bg-rose-600 text-white hover:bg-rose-500 focus-visible:outline-rose-600 disabled:bg-rose-300 dark:disabled:bg-rose-900',
  }[variant]
  const sizes = {
    sm: 'h-8 px-2.5 text-xs',
    md: 'h-9 px-3.5 text-sm',
  }[size]
  return (
    <button
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed',
        styles,
        sizes,
        className,
      )}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', className)}>
      {children}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-100 dark:bg-slate-800', className)} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string | null
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 px-6 py-14 text-center dark:border-slate-800">
      {icon ?? <Inbox className="h-10 w-10 text-slate-300 dark:text-slate-600" />}
      <p className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</p>
      {description ? <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function Badge({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: 'slate' | 'green' | 'amber' | 'rose' | 'sky' | 'indigo'
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
    rose: 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300',
    sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300',
    indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300',
  }[tone]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ring-black/5 dark:ring-white/10', tones)}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Modal + confirm
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
  hideClose,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
  hideClose?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-slate-950/30 p-4 backdrop-blur-[2px] sm:p-8">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={cn('my-auto w-full rounded-xl border border-slate-200 bg-white shadow-[0_24px_60px_-24px_rgba(9,9,11,0.35)] focus:outline-none dark:border-slate-800 dark:bg-slate-900', width)}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          {!hideClose && (
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">{footer}</div>
        ) : null}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
  confirmDisabled,
  children,
}: {
  open: boolean
  title: ReactNode
  message?: ReactNode
  confirmText?: string
  cancelText?: string
  tone?: 'danger' | 'primary'
  onConfirm: () => void
  onCancel: () => void
  confirmDisabled?: boolean
  children?: ReactNode
}) {
  const [busy, setBusy] = React.useState(false)
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className={tone === 'danger' ? 'h-5 w-5 text-rose-500' : 'h-5 w-5 text-indigo-500'} />
          {title}
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={busy}
            disabled={confirmDisabled}
            onClick={() => {
              setBusy(true)
              try {
                onConfirm()
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {message ? <div className="text-sm text-slate-600 dark:text-slate-300">{message}</div> : null}
      {children}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-600 dark:focus:border-slate-500 dark:focus:ring-white/10',
        props.className,
      )}
    />
  )
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-600 dark:focus:border-slate-500 dark:focus:ring-white/10',
        props.className,
      )}
    />
  )
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
        props.className,
      )}
    />
  )
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <label className="mb-1.5 block text-xs font-medium tracking-wide text-slate-600 dark:text-slate-400">
      {children}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Table + pagination
// ---------------------------------------------------------------------------

export function Table({ headers, rows, empty }: { headers: ReactNode[]; rows: ReactNode[][]; empty?: ReactNode }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {empty ?? 'No rows'}
      </div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className="border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/70 dark:border-slate-800/70 dark:hover:bg-slate-800/40"
            >
              {r.map((cell, j) => (
                <td key={j} className="px-3 py-2 align-top text-slate-700 dark:text-slate-200">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Pagination({
  offset,
  limit,
  total,
  onPage,
}: {
  offset: number
  limit: number
  total: number | null
  onPage: (offset: number) => void
}) {
  const page = Math.floor(offset / limit) + 1
  const lastPage = total === null ? null : Math.max(1, Math.ceil(total / limit))
  const canPrev = offset > 0
  const canNext = total === null || offset + limit < total
  return (
    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
      <span>
        {total === null ? (
          <>Showing rows {offset + 1}–{offset + limit}</>
        ) : total === 0 ? (
          <>0 rows</>
        ) : (
          <>Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}</>
        )}
      </span>
      <span className="flex items-center gap-1">
        <Button variant="secondary" size="sm" disabled={!canPrev} onClick={() => onPage((page - 2) * limit)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[3rem] text-center">{lastPage ? `${page} / ${lastPage}` : String(page)}</span>
        <Button variant="secondary" size="sm" disabled={!canNext} onClick={() => onPage(page * limit)} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-xl border border-rose-200 bg-rose-50/50 px-6 py-12 text-center dark:border-rose-900 dark:bg-rose-950/30">
          <AlertTriangle className="h-10 w-10 text-rose-500" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Something went wrong</h2>
          <p className="max-w-md text-sm text-slate-600 dark:text-slate-300">{this.state.error.message}</p>
          <button
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export { cn }