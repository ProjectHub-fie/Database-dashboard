import { useEffect, useRef, useState } from 'react'
import { ReconnectLoader } from './loaders/PageLoader'
import { useNetwork } from '../contexts/NetworkContext'
import { useToast } from '../contexts/ToastContext'

/**
 * Covers the app while the API is unreachable, and gets out of the way the
 * moment a probe succeeds.
 *
 * Kept above the router on purpose: an outage is not a page. Replacing the
 * current route would unmount the operator's work — a half-written statement in
 * SQL Studio, a filtered data table — so the overlay sits on top and the page
 * underneath survives the gap.
 */
export function ReconnectOverlay() {
  const { state, attempt, since, retryNow } = useNetwork()
  const { toast } = useToast()
  const [elapsedMs, setElapsedMs] = useState(0)
  const wasReconnecting = useRef(false)

  useEffect(() => {
    if (state !== 'reconnecting') {
      setElapsedMs(0)
      return
    }
    const startedAt = since ?? Date.now()
    setElapsedMs(Date.now() - startedAt)
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000)
    return () => window.clearInterval(timer)
  }, [state, since])

  useEffect(() => {
    if (wasReconnecting.current && state === 'online') {
      toast('success', 'Back online', 'Reconnected to the server.')
    }
    wasReconnecting.current = state === 'reconnecting'
  }, [state, toast])

  if (state !== 'reconnecting') return null
  return <ReconnectLoader attempt={attempt} elapsedMs={elapsedMs} onRetry={retryNow} />
}
