import { cn } from '../../lib/cn'
import { SkeletonBlock, SkeletonLine, SkeletonRegion } from './PageLoader'

/**
 * Shape-matching placeholders.
 *
 * Each skeleton mirrors the dimensions of the content that replaces it, so the
 * panel does not jump when data lands. They are deliberately content-shaped
 * (stat cards, list rows, table rows, result grid) rather than a single grey
 * rectangle — a loader that copies the layout reads as "loading this exact
 * thing", not "something is wrong".
 */

export function SkeletonStatCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <SkeletonLine width="w-28" />
          <SkeletonBlock className="mt-3 h-6 w-20" />
        </div>
      ))}
    </div>
  )
}

/** Stacked rows for list panels (connections, history, saved queries). */
export function SkeletonList({ rows = 4, rowClassName }: { rows?: number; rowClassName?: string }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={cn('flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-900/50', rowClassName)}>
          <SkeletonBlock className="h-3.5 w-3.5 shrink-0 rounded-full" />
          <SkeletonLine width={i % 2 === 0 ? 'w-2/5' : 'w-1/3'} />
          <SkeletonBlock className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  )
}

/** Table skeleton: a header band plus `rows` body rows and `columns` cells. */
export function SkeletonTable({
  rows = 8,
  columns = 4,
  className,
}: {
  rows?: number
  columns?: number
  className?: string
}) {
  return (
    <div className={cn('divide-y divide-slate-100 dark:divide-slate-800', className)}>
      <div className="flex items-center gap-4 px-2.5 py-2">
        {Array.from({ length: columns }).map((_, i) => (
          <SkeletonBlock key={i} className={cn('h-2.5', i === 0 ? 'w-10' : 'flex-1 max-w-[9rem]')} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-2.5 py-2">
          {Array.from({ length: columns }).map((_, c) => (
            <SkeletonBlock
              key={c}
              className={cn('h-3', c === 0 ? 'w-6' : 'flex-1 max-w-[9rem]')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Whole-dashboard placeholder: stat cards over two content panels. */
export function DashboardSkeleton({ label = 'Loading dashboard' }: { label?: string }) {
  return (
    <SkeletonRegion label={label} className="space-y-4">
      <SkeletonStatCards />
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex items-center justify-between">
              <SkeletonLine width="w-40" />
              <SkeletonLine width="w-16" />
            </div>
            <SkeletonList rows={i === 0 ? 3 : 4} />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  )
}
