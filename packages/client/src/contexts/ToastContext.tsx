import { createContext, useCallback, useContext, useState, ReactNode } from 'react'
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: number
  kind: ToastKind
  message: string
  detail?: string
}

interface ToastContextValue {
  toast: (kind: ToastKind, message: string, detail?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

let nextId = 1

const icons: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
  error: <XCircle className="h-5 w-5 text-rose-500" />,
  warning: <AlertTriangle className="h-5 w-5 text-amber-500" />,
  info: <Info className="h-5 w-5 text-sky-500" />,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      const id = nextId++
      setToasts((ts) => [...ts.slice(-4), { id, kind, message, detail }])
      window.setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4200)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed right-4 top-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="alert"
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-800"
          >
            <div className="mt-0.5 shrink-0">{icons[t.kind]}</div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t.message}</p>
              {t.detail ? (
                <p className="mt-0.5 break-words text-xs text-slate-500 dark:text-slate-400">{t.detail}</p>
              ) : null}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}