import { API_BASE } from './api-base'

/**
 * Tracks whether this browser can still reach the API.
 *
 * Two things go wrong on a real network and they need different handling: the
 * browser loses its link (`fetch` rejects, or `navigator.onLine` flips false),
 * or a deploy briefly answers 5xx at the platform edge. Both look identical to
 * the operator — a page whose every panel fails — so both funnel into one
 * "reconnecting" state with a probe loop, rather than leaving them to guess
 * from a scatter of identical errors.
 *
 * Nothing here throws at a caller: the monitor reports, the UI decides.
 */

export type LinkState = 'online' | 'reconnecting'

export interface LinkSnapshot {
  state: LinkState
  /** Consecutive failed probes since the link dropped; 0 while online. */
  attempt: number
  /** Epoch ms the current outage started, or null while online. */
  since: number | null
}

export const BACKOFF_MS = [1_000, 2_000, 3_000, 5_000, 8_000] as const

/** A single failed request is usually a blip (a dropped keep-alive, a laptop
 *  changing networks). Waiting out this window keeps the full-screen loader
 *  from flashing on every hiccup, while `navigator.onLine === false` skips it. */
export const GRACE_MS = 700

const PROBE_TIMEOUT_MS = 6_000

type Listener = (snapshot: LinkSnapshot) => void

export interface LinkMonitorOptions {
  /** Resolve true when the API answered at all. Injected by tests. */
  probe?: () => Promise<boolean>
  graceMs?: number
  backoffMs?: readonly number[]
  probeTimeoutMs?: number
  now?: () => number
}

export class LinkMonitor {
  private snapshot: LinkSnapshot = { state: 'online', attempt: 0, since: null }
  private readonly listeners = new Set<Listener>()
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private probing = false
  /** A retry was requested while a probe was in flight. Dropping it would make
   *  the Retry button appear dead exactly when someone is watching it. */
  private probeAgain = false
  private disposed = false
  /** Bumped whenever real traffic proves the API is up, so an in-flight probe
   *  cannot overwrite that newer truth with its own stale failure. */
  private epoch = 0
  private readonly graceMs: number
  private readonly backoffMs: readonly number[]
  private readonly probeTimeoutMs: number
  private readonly now: () => number
  private readonly doProbe: () => Promise<boolean>

  constructor(opts: LinkMonitorOptions = {}) {
    this.graceMs = opts.graceMs ?? GRACE_MS
    this.backoffMs = opts.backoffMs ?? BACKOFF_MS
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    this.now = opts.now ?? (() => Date.now())
    this.doProbe = opts.probe ?? (() => probeHealth(this.probeTimeoutMs))
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): LinkSnapshot => this.snapshot

  /** Any HTTP response at all — including a 401 or 500 with a JSON body —
   *  proves the API is reachable. Only a transport failure is a link loss. */
  reportReachable(): void {
    if (this.disposed) return
    this.epoch++
    this.clearTimers()
    if (this.snapshot.state === 'online') return
    this.setSnapshot({ state: 'online', attempt: 0, since: null })
  }

  /** `fetch` rejected or timed out. Starts the grace window, then probes. */
  reportUnreachable(): void {
    if (this.disposed) return
    if (this.snapshot.state === 'reconnecting') {
      // Already waiting; let the probe loop own the timing.
      if (!this.probeTimer && !this.probing) this.scheduleProbe(0)
      return
    }
    if (this.graceTimer) return
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      this.enterReconnecting()
    }, this.graceMs)
  }

  /** The browser reported no network at all — no grace, it is unambiguous. */
  goOffline(): void {
    if (this.disposed) return
    this.clearTimers()
    this.enterReconnecting()
  }

  /** Probe immediately, e.g. on the `online` event or a manual retry. */
  probeNow(): void {
    if (this.disposed) return
    this.clearTimers()
    void this.runProbe()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
    this.listeners.clear()
  }

  private enterReconnecting(): void {
    if (this.snapshot.state === 'reconnecting') return
    this.setSnapshot({ state: 'reconnecting', attempt: 0, since: this.now() })
    // Probe immediately: the outage may already be over by the time the state
    // renders, and waiting a tick only delays getting the operator back.
    void this.runProbe()
  }

  private scheduleProbe(delayMs: number): void {
    if (this.disposed) return
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      void this.runProbe()
    }, delayMs)
  }

  private backoffFor(attempt: number): number {
    const index = Math.min(attempt, this.backoffMs.length - 1)
    return this.backoffMs[index]
  }

  private async runProbe(): Promise<void> {
    if (this.disposed) return
    if (this.probing) {
      this.probeAgain = true
      return
    }
    this.probing = true
    const epoch = this.epoch
    let ok = false
    try {
      ok = await this.doProbe()
    } catch {
      ok = false
    } finally {
      this.probing = false
    }
    if (this.disposed) return
    if (ok) {
      this.probeAgain = false
      this.clearTimers()
      this.setSnapshot({ state: 'online', attempt: 0, since: null })
      return
    }
    // A normal request proved the API was up while this probe was in flight.
    if (this.epoch !== epoch) return
    if (this.probeAgain) {
      this.probeAgain = false
      this.clearTimers()
      void this.runProbe()
      return
    }
    const attempt = this.snapshot.attempt + 1
    this.setSnapshot({
      state: 'reconnecting',
      attempt,
      since: this.snapshot.since ?? this.now(),
    })
    this.scheduleProbe(this.backoffFor(attempt))
  }

  private clearTimers(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
  }

  private setSnapshot(next: LinkSnapshot): void {
    const prev = this.snapshot
    if (prev.state === next.state && prev.attempt === next.attempt && prev.since === next.since) return
    this.snapshot = next
    for (const listener of this.listeners) listener(next)
  }
}

/**
 * Resolve whether the API itself is up.
 *
 * Any HTTP status counts — a JSON 503 means Express answered and the outage is
 * upstream of it. A *non-JSON* answer does not: when `API_ORIGIN` points at a
 * serverless host or at this same deployment, the platform serves the SPA
 * fallback and every `/api` path returns `index.html`. That would look like a
 * healthy link and clear the overlay over a deployment that cannot work, so the
 * probe requires the JSON envelope every `/api` route is contractually required
 * to send.
 */
async function probeHealth(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}/api/healthz`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    await res.json()
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** The app-wide monitor. One link, one state, one probe loop. */
export const link = new LinkMonitor()
