import { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/**
 * The DB Remote boot loader.
 *
 * Shown only while the application is answering its first questions — "who am
 * I" and "is there a live connection" — never to decorate an in-page fetch
 * (those use `DashboardSkeleton` or `InlineLoader`). The status text is driven
 * by the bootstrap step that is actually in flight, so it never claims progress
 * the client cannot observe.
 */

export type BootPhase =
  | 'initializing'
  | 'authenticating'
  | 'connecting'
  | 'fetching'
  | 'preparing'

const PHASE_COPY: Record<BootPhase, string> = {
  initializing: 'Initializing dashboard…',
  authenticating: 'Establishing secure connection…',
  connecting: 'Establishing secure connection…',
  fetching: 'Fetching database information…',
  preparing: 'Preparing your workspace…',
}

export function PageLoader({
  phase = 'initializing',
  message,
  detail,
  className,
}: {
  phase?: BootPhase
  /** Overrides the default copy for the phase. */
  message?: string
  /** Optional second line — a real, non-secret fact about what is happening. */
  detail?: string
  className?: string
}) {
  const status = message ?? PHASE_COPY[phase]
  return (
    <div
      className={cn(
        'dbh-loader flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center',
        'bg-slate-50 dark:bg-slate-950',
        className,
      )}
    >
      <LoaderStage />

      <div role="status" aria-live="polite" className="flex flex-col items-center gap-2">
        <p className="dbh-loader-wordmark text-lg font-semibold text-slate-900 dark:text-white">DB Remote</p>
        <p key={status} className="dbh-loader-status text-sm text-slate-500 dark:text-slate-400">
          {status}
        </p>
        {detail ? <p className="text-xs text-slate-400 dark:text-slate-500">{detail}</p> : null}
      </div>

      <span className="dbh-loader-track" aria-hidden="true" />
    </div>
  )
}

/** The orbit stage — shared by the boot loader and the reconnect overlay so a
 *  dropped link looks like the same product, not a different error page. */
function LoaderStage() {
  return (
    <div className="dbh-loader-stage" aria-hidden="true">
      <span className="dbh-loader-halo" />
      <span className="dbh-ring dbh-ring-2" />
      <span className="dbh-ring dbh-ring-1" />
      <span className="dbh-ring dbh-ring-3" />
      <span className="dbh-trail" />
      <span className="dbh-cylinder">
        <span className="dbh-cylinder-cap" />
      </span>
    </div>
  )
}

/**
 * Full-screen "the network went away" state.
 *
 * Rendered as an overlay rather than a route so whatever the operator was doing
 * stays mounted underneath and is still there when the link returns. No spinner
 * of its own: the probe loop in `lib/link.ts` owns retrying, and this only
 * reports what the loop knows.
 */
export function ReconnectLoader({
  attempt = 0,
  elapsedMs = 0,
  onRetry,
}: {
  /** Failed probes so far. 0 means the first probe has not returned yet. */
  attempt?: number
  elapsedMs?: number
  onRetry?: () => void
}) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const since = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'dbh-loader dbh-reconnect fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6 text-center',
        // Near-opaque, not solid: the page the operator was on stays faintly
        // visible so the overlay reads as "paused", not "you lost your work".
        'bg-slate-50/95 backdrop-blur-sm dark:bg-slate-950/95',
      )}
    >
      <LoaderStage />

      <div className="flex flex-col items-center gap-2">
        <p className="dbh-loader-wordmark text-lg font-semibold text-slate-900 dark:text-white">DB Remote</p>
        <p className="dbh-loader-status dbh-reconnect-line text-sm text-slate-500 dark:text-slate-400">
          Disconnected
          <span className="dbh-dots" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>{' '}
          Reconnecting
        </p>
        <p className="text-xs text-slate-400 dark:text-slate-500">
          {attempt > 0
            ? `No response from the server for ${since} · attempt ${attempt} · retrying automatically`
            : `No response from the server for ${since} · checking the connection`}
        </p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Retry now
          </button>
        ) : null}
      </div>

      <span className="dbh-loader-track" aria-hidden="true" />
    </div>
  )
}

/** Compact loader for a panel that is filling in but already has its frame. */
export function InlineLoader({
  label,
  className,
  size = 'sm',
}: {
  label: string
  className?: string
  size?: 'sm' | 'md'
}) {
  const dims = size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5'
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn('inline-flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400', className)}
    >
      <svg className={cn('dbh-inline-spinner shrink-0', dims)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** Shimmering placeholder block. Sizes come from the caller so the real layout
 *  dimensions are preserved and nothing shifts when content arrives. */
export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('dbh-skeleton', className)} aria-hidden="true" />
}

/** Text-friendly skeleton line. */
export function SkeletonLine({ width = 'w-full', className }: { width?: string; className?: string }) {
  return <div className={cn('dbh-skeleton h-3', width, className)} aria-hidden="true" />
}

/** Wrapper that announces one loading region instead of every placeholder bar. */
export function SkeletonRegion({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}
