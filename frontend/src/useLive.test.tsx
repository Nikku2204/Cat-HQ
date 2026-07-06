// Unit tests for useLive (docs/04-TESTING.md Phase 3).
// No network: ./api is fully mocked and the WebSocket global is a hand-rolled
// mock class. Math.random is pinned to 0.5 so the backoff jitter factor is
// (0.8 + 0.5 * 0.4) === 1.0 exactly — delays are deterministic.
import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { useLive } from './useLive'
import { api, fireUnauthorized, getToken } from './api'
import type {
  AdapterHealth,
  DeviceEntry,
  DeviceState,
  Devices,
  WsMessage,
} from './types'

vi.mock('./api', () => ({
  api: { devices: vi.fn() },
  getToken: vi.fn(),
  fireUnauthorized: vi.fn(),
}))

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readonly url: string
  readonly protocols: string | string[] | undefined
  readyState: number = MockWebSocket.CONNECTING

  onopen: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: MessageEvent<string>) => unknown) | null = null
  onclose: ((ev: CloseEvent) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null

  send = vi.fn<(data: string) => void>()
  close = vi.fn(() => {
    if (
      this.readyState === MockWebSocket.CONNECTING ||
      this.readyState === MockWebSocket.OPEN
    ) {
      this.readyState = MockWebSocket.CLOSING
    }
  })

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    MockWebSocket.instances.push(this)
  }

  /** Test helper: server accepted the handshake. */
  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  /** Test helper: server pushed a JSON frame. */
  message(msg: WsMessage): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }))
  }

  /** Test helper: connection dropped (readyState CLOSED first, like the real API). */
  closeFromServer(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

// --- tiny factories -------------------------------------------------------

const T1 = '2026-07-05T10:00:00Z'
const T2 = '2026-07-05T11:00:00Z'
const T3 = '2026-07-05T12:00:00Z'

const mkHealth = (over: Partial<AdapterHealth> = {}): AdapterHealth => ({
  status: 'ok',
  detail: '',
  last_success_utc: T1,
  consecutive_failures: 0,
  ...over,
})

const mkState = (
  id: string,
  fetchedAt: string,
  attrs: Record<string, unknown> = {},
): DeviceState => ({
  device_id: id,
  device_type: id,
  fetched_at_utc: fetchedAt,
  attributes: attrs,
})

const mkEntry = (
  id: string,
  fetchedAt: string,
  attrs: Record<string, unknown> = {},
): DeviceEntry => ({ health: mkHealth(), state: mkState(id, fetchedAt, attrs) })

const hello = (devices: Devices): WsMessage => ({ kind: 'hello', devices })
const stateMsg = (deviceId: string, st: DeviceState): WsMessage => ({
  kind: 'state',
  device_id: deviceId,
  health: mkHealth(),
  state: st,
})

// --- async helpers --------------------------------------------------------

/** Flush pending microtasks (e.g. the initial REST snapshot merge) inside act. */
const flush = () => act(async () => {})
/** Advance fake timers inside act so timer-driven setState is covered. */
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms)
  })

describe('useLive', () => {
  beforeEach(() => {
    // vitest 4: restoreAllMocks only touches vi.spyOn spies, so the module
    // mocks' call history must be cleared explicitly between tests.
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // jitter factor === 1.0
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.mocked(getToken).mockReturnValue('tok')
    vi.mocked(api.devices).mockResolvedValue({ devices: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('connects to /ws with ["cathq", token] subprotocols and hello replaces the whole store', async () => {
    const { result } = renderHook(() => useLive())
    await flush()

    expect(MockWebSocket.instances).toHaveLength(1)
    const sock = MockWebSocket.instances[0]
    expect(sock.url).toMatch(/^ws:\/\/.+\/ws$/)
    expect(sock.protocols).toEqual(['cathq', 'tok'])
    expect(result.current.conn).toBe('connecting')

    await act(async () => sock.open())
    expect(result.current.conn).toBe('live')

    await act(async () =>
      sock.message(
        hello({
          litterrobot: mkEntry('litterrobot', T1, { status_text: 'Ready' }),
          feeder: mkEntry('feeder', T1, { name: 'chutku food' }),
        }),
      ),
    )
    expect(Object.keys(result.current.devices).sort()).toEqual([
      'feeder',
      'litterrobot',
    ])

    // a later hello is a full snapshot: devices absent from it drop out
    await act(async () =>
      sock.message(hello({ feeder: mkEntry('feeder', T2, { name: 'chutku food' }) })),
    )
    expect(result.current.devices).toEqual({
      feeder: mkEntry('feeder', T2, { name: 'chutku food' }),
    })
  })

  it('a state message merges one device and leaves the others untouched', async () => {
    const { result } = renderHook(() => useLive())
    await flush()
    const sock = MockWebSocket.instances[0]
    await act(async () => {
      sock.open()
      sock.message(
        hello({
          litterrobot: mkEntry('litterrobot', T1, { status_text: 'Ready' }),
          feeder: mkEntry('feeder', T1, { name: 'chutku food' }),
        }),
      )
    })

    await act(async () =>
      sock.message(
        stateMsg(
          'litterrobot',
          mkState('litterrobot', T2, { status_text: 'Clean Cycle In Progress' }),
        ),
      ),
    )

    expect(result.current.devices['litterrobot']?.state?.fetched_at_utc).toBe(T2)
    expect(result.current.devices['litterrobot']?.state?.attributes).toEqual({
      status_text: 'Clean Cycle In Progress',
    })
    // the other device kept its entry exactly as delivered
    expect(result.current.devices['feeder']).toEqual(
      mkEntry('feeder', T1, { name: 'chutku food' }),
    )
  })

  it('reconnects on close with growing backoff and probes REST after repeated failures', async () => {
    renderHook(() => useLive())
    await flush()
    expect(vi.mocked(api.devices)).toHaveBeenCalledTimes(1) // first-paint snapshot
    expect(MockWebSocket.instances).toHaveLength(1)

    // close #1: attempts 0 → delay exactly 1000ms (jitter pinned to 1.0)
    await act(async () => MockWebSocket.instances[0].closeFromServer())
    await advance(900)
    expect(MockWebSocket.instances).toHaveLength(1) // not before ~0.8 * 1000
    await advance(200)
    expect(MockWebSocket.instances).toHaveLength(2)

    // close #2: attempts 1 → delay 2000ms
    await act(async () => MockWebSocket.instances[1].closeFromServer())
    await advance(1800)
    expect(MockWebSocket.instances).toHaveLength(2)
    await advance(400)
    expect(MockWebSocket.instances).toHaveLength(3)
    expect(vi.mocked(api.devices)).toHaveBeenCalledTimes(1) // no 401-probe yet

    // close #3: attempts 2 → the REST 401-probe fires, delay 4000ms
    await act(async () => MockWebSocket.instances[2].closeFromServer())
    expect(vi.mocked(api.devices)).toHaveBeenCalledTimes(2)
    await advance(3600)
    expect(MockWebSocket.instances).toHaveLength(3)
    await advance(800)
    expect(MockWebSocket.instances).toHaveLength(4)
  })

  it('starts a 25s ping interval on open and clears it on close', async () => {
    const { result } = renderHook(() => useLive())
    await flush()
    const sock = MockWebSocket.instances[0]
    await act(async () => sock.open())

    expect(sock.send).not.toHaveBeenCalled()
    await advance(25_000)
    expect(sock.send).toHaveBeenCalledTimes(1)
    expect(sock.send).toHaveBeenCalledWith('ping')
    await advance(25_000)
    expect(sock.send).toHaveBeenCalledTimes(2)

    await act(async () => sock.closeFromServer())
    expect(result.current.conn).toBe('offline')
    await advance(120_000) // reconnect socket appears, but the old ping is dead
    expect(sock.send).toHaveBeenCalledTimes(2)
    // the replacement socket never opened, so no interval started there either
    expect(MockWebSocket.instances[1].send).not.toHaveBeenCalled()
  })

  it('StrictMode double-mount settles on one live socket; superseded socket events are inert', async () => {
    // NB: StrictMode must be the wrapper itself (the ROOT element). Nesting
    // <StrictMode> inside a wrapper component does NOT arm dev double-effects
    // for the initial root mount (verified empirically against React 19.2.7).
    const { result } = renderHook(() => useLive(), { wrapper: StrictMode })
    await flush()

    // mount → cleanup → mount: the first socket was detached and closed
    expect(MockWebSocket.instances).toHaveLength(2)
    const [stale, live] = MockWebSocket.instances
    expect(stale.close).toHaveBeenCalledTimes(1)
    expect(live.close).not.toHaveBeenCalled()
    expect(stale.onmessage).toBeNull() // handlers detached

    // events on the superseded socket never touch state or schedule retries
    await act(async () => {
      stale.message(hello({ litterrobot: mkEntry('litterrobot', T1) }))
      stale.closeFromServer()
    })
    expect(result.current.devices).toEqual({})
    expect(result.current.conn).toBe('connecting')

    await act(async () => {
      live.open()
      live.message(hello({ feeder: mkEntry('feeder', T1) }))
    })
    expect(result.current.conn).toBe('live')
    expect(Object.keys(result.current.devices)).toEqual(['feeder'])

    // the stale close scheduled no reconnect: no third socket ever appears
    await advance(60_000)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(
      MockWebSocket.instances.filter((s) => s.readyState === MockWebSocket.OPEN),
    ).toHaveLength(1)
  })

  it('visibilitychange with a CLOSED socket reconnects immediately, resets backoff, refetches REST', async () => {
    renderHook(() => useLive())
    await flush()

    // drive the backoff up through three failures
    await act(async () => MockWebSocket.instances[0].closeFromServer()) // → 1000ms
    await advance(1000)
    await act(async () => MockWebSocket.instances[1].closeFromServer()) // → 2000ms
    await advance(2000)
    expect(MockWebSocket.instances).toHaveLength(3)
    await act(async () => MockWebSocket.instances[2].closeFromServer()) // probe, → 4000ms pending
    expect(vi.mocked(api.devices)).toHaveBeenCalledTimes(2) // initial + failure probe

    // tab returns to the foreground (jsdom visibilityState is 'visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(vi.mocked(api.devices)).toHaveBeenCalledTimes(3) // bridge refetch
    expect(MockWebSocket.instances).toHaveLength(4) // immediate, no timer advance

    // attempts were reset: next backoff is the small first-step delay again
    await act(async () => MockWebSocket.instances[3].closeFromServer())
    await advance(900)
    expect(MockWebSocket.instances).toHaveLength(4)
    await advance(200)
    expect(MockWebSocket.instances).toHaveLength(5)

    // the pre-visibility 4000ms timer was cleared — no ghost socket later
    await act(async () => MockWebSocket.instances[4].open())
    await advance(30_000)
    expect(MockWebSocket.instances).toHaveLength(5)
  })

  it('REST snapshot merge never overwrites fresher WS state (fetched_at_utc guard)', async () => {
    let resolveSnap!: (v: { devices: Devices }) => void
    vi.mocked(api.devices).mockImplementation(
      () =>
        new Promise((res) => {
          resolveSnap = res
        }),
    )
    const { result } = renderHook(() => useLive())
    const sock = MockWebSocket.instances[0]

    await act(async () => {
      sock.open()
      sock.message(
        stateMsg('litterrobot', mkState('litterrobot', T3, { status_text: 'fresh-ws' })),
      )
    })
    expect(result.current.devices['litterrobot']?.state?.attributes['status_text']).toBe(
      'fresh-ws',
    )

    // the mount-time GET finally lands, carrying STALER litterrobot data
    await act(async () => {
      resolveSnap({
        devices: {
          litterrobot: mkEntry('litterrobot', T2, { status_text: 'stale-rest' }),
          feeder: mkEntry('feeder', T2, { name: 'chutku food' }),
        },
      })
    })

    // WS value survives; devices the store didn't know about still merge in
    expect(result.current.devices['litterrobot']?.state?.fetched_at_utc).toBe(T3)
    expect(result.current.devices['litterrobot']?.state?.attributes['status_text']).toBe(
      'fresh-ws',
    )
    expect(result.current.devices['feeder']?.state?.attributes['name']).toBe(
      'chutku food',
    )
    expect(result.current.conn).toBe('live')
  })

  it('no stored token at connect time → conn offline, fireUnauthorized, no socket', async () => {
    vi.mocked(getToken).mockReturnValue(null)
    const { result } = renderHook(() => useLive())

    expect(result.current.conn).toBe('offline')
    expect(vi.mocked(fireUnauthorized)).toHaveBeenCalledTimes(1)
    expect(MockWebSocket.instances).toHaveLength(0)
    // the REST snapshot fetch was still attempted (its own 401 handling applies)
    expect(vi.mocked(api.devices)).toHaveBeenCalledTimes(1)
    await flush()
  })

  it('unmount closes the live socket and stops the ping interval', async () => {
    const { unmount } = renderHook(() => useLive())
    await flush()
    const sock = MockWebSocket.instances[0]
    await act(async () => sock.open())

    unmount()
    expect(sock.close).toHaveBeenCalledTimes(1)
    expect(sock.onmessage).toBeNull() // detached before close

    await advance(120_000)
    expect(sock.send).not.toHaveBeenCalled() // ping interval cleared
    expect(MockWebSocket.instances).toHaveLength(1) // no reconnects after unmount
  })

  it('unmount clears a pending reconnect timer', async () => {
    const { unmount } = renderHook(() => useLive())
    await flush()
    await act(async () => MockWebSocket.instances[0].closeFromServer()) // reconnect in 1000ms

    unmount()
    await advance(60_000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})
