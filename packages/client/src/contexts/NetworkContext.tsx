import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, ReactNode } from 'react'
import { link, LinkSnapshot } from '../lib/link'

interface NetworkContextValue extends LinkSnapshot {
  /** Skip the current backoff and probe immediately. */
  retryNow: () => void
}

const NetworkContext = createContext<NetworkContextValue | null>(null)

/**
 * Subscribes the tree to the link monitor and bridges the browser's own
 * connectivity events. The monitor owns probing and backoff; this only forwards
 * signals, so nothing here can report "online" without a successful probe.
 */
export function NetworkProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(link.subscribe, link.getSnapshot, link.getSnapshot)

  useEffect(() => {
    const onOffline = () => link.goOffline()
    // The browser says a network exists again. That is a hint, not proof — the
    // API may still be unreachable — so probe instead of declaring recovery.
    const onOnline = () => link.probeNow()
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    if (navigator.onLine === false) link.goOffline()
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  const value = useMemo<NetworkContextValue>(
    () => ({ ...snapshot, retryNow: () => link.probeNow() }),
    [snapshot],
  )

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
}

export function useNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext)
  if (!ctx) throw new Error('useNetwork must be used within NetworkProvider')
  return ctx
}

/**
 * Run `onReconnect` when the link comes back after having been lost.
 *
 * The overlay preserves the page underneath, which means a panel whose fetch
 * failed during the outage keeps rendering its stale "Network error" once the
 * link returns — technically true when it rendered, misleading by the time the
 * overlay clears. Pages hand their loader here so recovery is real, not just
 * cosmetic. Pass a stable callback: it is kept in a ref, so an inline arrow
 * works without re-subscribing.
 */
export function useOnReconnect(onReconnect: () => void): void {
  const { state } = useNetwork()
  const callback = useRef(onReconnect)
  callback.current = onReconnect
  const previous = useRef(state)

  useEffect(() => {
    if (previous.current === 'reconnecting' && state === 'online') callback.current()
    previous.current = state
  }, [state])
}
