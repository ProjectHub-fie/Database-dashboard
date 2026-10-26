import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LinkMonitor, BACKOFF_MS, GRACE_MS, LinkSnapshot } from './link'

/**
 * The reconnect overlay is driven entirely by these transitions. Getting them
 * wrong shows a full-screen "Disconnected" to someone whose Wi-Fi is fine, or
 * leaves them staring at a dead page with no retry — so each rule is pinned.
 */
function makeMonitor(probe: () => Promise<boolean>, opts: { graceMs?: number } = {}) {
  const monitor = new LinkMonitor({ probe, graceMs: opts.graceMs ?? GRACE_MS })
  const seen: LinkSnapshot[] = []
  monitor.subscribe((s) => seen.push(s))
  return { monitor, seen, state: () => monitor.getSnapshot() }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LinkMonitor', () => {
  it('ignores a single failed request inside the grace window', async () => {
    const { monitor, seen } = makeMonitor(async () => false)
    monitor.reportUnreachable()
    expect(monitor.getSnapshot().state).toBe('online')

    await vi.advanceTimersByTimeAsync(GRACE_MS - 1)
    expect(monitor.getSnapshot().state).toBe('online')
    // Nothing was reported, so nothing re-rendered: no flash of the overlay.
    expect(seen).toHaveLength(0)
    monitor.dispose()
  })

  it('enters reconnecting once the outage outlives the grace window', async () => {
    const { monitor } = makeMonitor(async () => false)
    monitor.reportUnreachable()
    await vi.advanceTimersByTimeAsync(GRACE_MS)

    expect(monitor.getSnapshot().state).toBe('reconnecting')
    expect(monitor.getSnapshot().since).toBeTypeOf('number')
    monitor.dispose()
  })

  it('cancels the outage when a real request succeeds first', async () => {
    const { monitor, seen } = makeMonitor(async () => false)
    monitor.reportUnreachable()
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2)
    monitor.reportReachable()
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)

    expect(monitor.getSnapshot().state).toBe('online')
    expect(seen).toHaveLength(0)
    monitor.dispose()
  })

  it('recovers as soon as a probe succeeds, resetting the attempt count', async () => {
    let up = false
    const { monitor } = makeMonitor(async () => up)
    monitor.reportUnreachable()
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1])
    expect(monitor.getSnapshot().attempt).toBeGreaterThan(0)

    up = true
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[BACKOFF_MS.length - 1])
    expect(monitor.getSnapshot()).toEqual({ state: 'online', attempt: 0, since: null })
    monitor.dispose()
  })

  it('backs off the probes instead of hammering a dead server', async () => {
    const probe = vi.fn(async () => false)
    const { monitor } = makeMonitor(probe)
    monitor.reportUnreachable()
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(probe).toHaveBeenCalledTimes(1)

    // attempt 1 -> wait BACKOFF_MS[1]
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1] - 1)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledTimes(2)

    // attempt 2 -> BACKOFF_MS[2], and the interval never shrinks
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[2])
    expect(probe).toHaveBeenCalledTimes(3)
    monitor.dispose()
  })

  it('clears the overlay the moment ordinary traffic answers', async () => {
    const { monitor } = makeMonitor(async () => false)
    monitor.reportUnreachable()
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(monitor.getSnapshot().state).toBe('reconnecting')

    // The user hit Retry and a normal request got through, in flight alongside
    // the probe loop. The response wins; the pending probe must not re-open it.
    monitor.reportReachable()
    expect(monitor.getSnapshot().state).toBe('online')

    await vi.advanceTimersByTimeAsync(BACKOFF_MS[BACKOFF_MS.length - 1] * 2)
    expect(monitor.getSnapshot().state).toBe('online')
    monitor.dispose()
  })

  it('skips the grace window when the browser reports no network at all', async () => {
    const { monitor } = makeMonitor(async () => false)
    monitor.goOffline()
    expect(monitor.getSnapshot().state).toBe('reconnecting')
    monitor.dispose()
  })

  it('treats a successful probe after an offline event as recovery', async () => {
    let up = false
    const { monitor } = makeMonitor(async () => up)
    monitor.goOffline()
    expect(monitor.getSnapshot().state).toBe('reconnecting')

    up = true
    monitor.probeNow()
    // The first probe is still in flight; the retry queues behind it.
    await vi.advanceTimersByTimeAsync(1)
    expect(monitor.getSnapshot().state).toBe('online')
    monitor.dispose()
  })

  it('stops probing after dispose', async () => {
    const probe = vi.fn(async () => false)
    const { monitor } = makeMonitor(probe)
    monitor.reportUnreachable()
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    probe.mockClear()
    monitor.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('default health probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats a JSON answer as reachable, even a 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'X', message: 'upstream' } }), { status: 503 })),
    )
    // No probe injected: this exercises the real `probeHealth`.
    const monitor = new LinkMonitor({ graceMs: 0 })
    monitor.reportUnreachable()
    await vi.advanceTimersByTimeAsync(10)
    expect(monitor.getSnapshot().state).toBe('online')
    monitor.dispose()
  })

  it('stays offline when the API answers with the SPA fallback', async () => {
    // API_ORIGIN pointing at the Vercel deployment makes every /api path return
    // index.html. Counting that as "reachable" would clear the overlay over a
    // deployment that can never work, hiding the real cause.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    )
    const monitor = new LinkMonitor({ graceMs: 0, backoffMs: [10_000] })
    monitor.reportUnreachable()
    await vi.advanceTimersByTimeAsync(10)
    expect(monitor.getSnapshot().state).toBe('reconnecting')
    expect(monitor.getSnapshot().attempt).toBe(1)
    monitor.dispose()
  })
})

