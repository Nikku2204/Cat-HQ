// docs/04-TESTING.md Phase 3 (updated for M5.5 UX v2) — FeederCard:
// not-configured placeholder, "No data — <detail>" fallback, three
// independent warning CHIPS (offline / dispenser_blocked / food_low),
// 24h feed dot-timeline, next-feed countdown, feed happy path through the
// real ConfirmButton (fake timers), stepper 1..12 clamp + api.feed(2),
// failure notice, and the disabled matrix (offline / blocked).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { api } from '../api'
import { fmtDayTime, fmtTime } from '../format'
import type { AdapterHealth, DeviceEntry, EventOut, FeederAttrs } from '../types'
import FeederCard from './FeederCard'

vi.mock('../api', () => ({
  api: {
    devices: vi.fn(),
    clean: vi.fn(),
    feed: vi.fn(),
    events: vi.fn(),
    plugOn: vi.fn(),
    plugOff: vi.fn(),
    plugCycle: vi.fn(),
    health: vi.fn(),
  },
}))

const mockEvents = vi.mocked(api.events)
const mockFeed = vi.mocked(api.feed)

function health(overrides: Partial<AdapterHealth> = {}): AdapterHealth {
  return {
    status: 'ok',
    detail: '',
    last_success_utc: null,
    consecutive_failures: 0,
    ...overrides,
  }
}

function feederEntry(
  attrOverrides: Partial<FeederAttrs> = {},
  healthOverrides: Partial<AdapterHealth> = {},
): DeviceEntry {
  const attrs: FeederAttrs = {
    name: 'chutku food',
    online: true,
    food_low: false,
    dispenser_blocked: false,
    running_state: 'IDLE',
    today_feed_count: 3,
    today_portions: 6,
    next_feed_time_utc: '2026-07-05T17:00:00Z',
    next_feed_portions: 2,
    ...attrOverrides,
  }
  return {
    health: health(healthOverrides),
    state: {
      device_id: 'feeder',
      device_type: 'feeder',
      fetched_at_utc: '2026-07-05T10:00:00Z',
      attributes: { ...attrs },
    },
  }
}

function feedEvt(overrides: Partial<EventOut> = {}): EventOut {
  return {
    id: 10,
    device_id: 'feeder',
    event_type: 'feed',
    ts_utc: '2026-07-05T08:00:00Z',
    source: 'history',
    data: { portions: 4 },
    ...overrides,
  }
}

function plugEntry(attrOverrides: Record<string, unknown> = {}): DeviceEntry {
  return {
    health: health(),
    state: {
      device_id: 'plug_feeder',
      device_type: 'plug',
      fetched_at_utc: '2026-07-05T10:00:00Z',
      attributes: {
        name: 'chutku food',
        model: 'H5083',
        online: true,
        power_on: true,
        ...attrOverrides,
      },
    },
  }
}

// Flush the mount effect's api.events promise so setLastFeed lands inside act.
const flushEffects = () => act(async () => {})

// The 600ms double-tap arm delay reads Date.now(); Date must be faked too or
// the confirming tap is treated as an accidental double-tap and ignored.
const FAKED = ['setTimeout', 'clearTimeout', 'Date'] as const

async function armAndConfirm(button: HTMLElement) {
  fireEvent.click(button) // arm
  act(() => {
    vi.advanceTimersByTime(700) // past the 600ms accidental-double-tap guard
  })
  await act(async () => {
    fireEvent.click(button) // confirm; flush the async command
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  // Hard rule: nothing may reach the network. api is module-mocked; this
  // stub makes any stray fetch blow up loudly instead of hitting :8000.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('network disabled in tests')
    }),
  )
  mockEvents.mockResolvedValue({ count: 0, events: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('FeederCard', () => {
  it('shows the not-configured placeholder and skips the event fetch when no entry', () => {
    render(<FeederCard />)
    expect(
      screen.getByText('Not configured — set PETLIBRO_* in .env'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(mockEvents).not.toHaveBeenCalled()
  })

  it('shows "No data — <detail>" when state is null', async () => {
    render(
      <FeederCard
        entry={{
          health: health({ status: 'error', detail: 'session expired' }),
          state: null,
        }}
      />,
    )
    await flushEffects()
    expect(screen.getByText('No data — session expired')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument() // HealthBadge
  })

  it('defaults to "adapter disconnected" when health.detail is empty', async () => {
    render(
      <FeederCard entry={{ health: health({ status: 'degraded' }), state: null }} />,
    )
    await flushEffects()
    expect(screen.getByText('No data — adapter disconnected')).toBeInTheDocument()
  })

  it('renders name, today totals, last feed and next schedule from attrs + event log', async () => {
    mockEvents.mockResolvedValue({ count: 1, events: [feedEvt()] })
    render(<FeederCard entry={feederEntry()} />)
    await flushEffects()

    expect(screen.getByText('chutku food')).toBeInTheDocument()
    expect(screen.getByText('Today').nextElementSibling).toHaveTextContent(
      '3 feeds · 6 portions',
    )
    expect(
      screen.getByText(`${fmtDayTime('2026-07-05T08:00:00Z')} · 4p`),
    ).toBeInTheDocument()
    // next feed renders a countdown plus the absolute time · portions
    expect(screen.getByText('Next feed').nextElementSibling).toHaveTextContent(
      `${fmtTime('2026-07-05T17:00:00Z')} · 2p`,
    )

    expect(mockEvents).toHaveBeenCalledWith({
      device: 'feeder',
      type: 'feed',
      limit: 60,
    })

    // Healthy: no warning chips, button enabled
    expect(screen.queryByText('📶 offline')).not.toBeInTheDocument()
    expect(screen.queryByText('⚠️ blocked')).not.toBeInTheDocument()
    expect(screen.queryByText('🍚 food low')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Feed 1 portion' })).toBeEnabled()
  })

  it('renders only the offline chip when online is false', async () => {
    render(<FeederCard entry={feederEntry({ online: false })} />)
    await flushEffects()
    expect(screen.getByText('📶 offline')).toBeInTheDocument()
    expect(screen.queryByText('⚠️ blocked')).not.toBeInTheDocument()
    expect(screen.queryByText('🍚 food low')).not.toBeInTheDocument()
  })

  it('renders only the blocked chip when dispenser_blocked is true', async () => {
    render(<FeederCard entry={feederEntry({ dispenser_blocked: true })} />)
    await flushEffects()
    expect(screen.getByText('⚠️ blocked')).toBeInTheDocument()
    expect(screen.queryByText('📶 offline')).not.toBeInTheDocument()
    expect(screen.queryByText('🍚 food low')).not.toBeInTheDocument()
  })

  it('renders only the food-low chip when food_low is true', async () => {
    render(<FeederCard entry={feederEntry({ food_low: true })} />)
    await flushEffects()
    expect(screen.getByText('🍚 food low')).toBeInTheDocument()
    expect(screen.queryByText('📶 offline')).not.toBeInTheDocument()
    expect(screen.queryByText('⚠️ blocked')).not.toBeInTheDocument()
  })

  it('places today\'s feeds on the 24h timeline, dot size scaling with portions', async () => {
    const today9am = new Date()
    today9am.setHours(9, 0, 0, 0)
    const today7am = new Date()
    today7am.setHours(7, 0, 0, 0)
    mockEvents.mockResolvedValue({
      count: 3,
      events: [
        feedEvt({ id: 3, ts_utc: today9am.toISOString(), data: { portions: 4 } }),
        feedEvt({ id: 2, ts_utc: today7am.toISOString(), data: { portions: 1 } }),
        // yesterday's feed must NOT get a dot
        feedEvt({
          id: 1,
          ts_utc: new Date(today9am.getTime() - 86_400_000).toISOString(),
          data: { portions: 2 },
        }),
      ],
    })
    const { container } = render(<FeederCard entry={feederEntry()} />)
    await flushEffects()

    const dots = container.querySelectorAll('.timeline-dot')
    expect(dots).toHaveLength(2)
    const [d7, d9] = [...dots] as HTMLElement[] // chronological (reversed)
    expect(parseFloat(d7.style.left)).toBeCloseTo((7 / 24) * 100, 0)
    expect(parseFloat(d9.style.left)).toBeCloseTo((9 / 24) * 100, 0)
    expect(parseFloat(d9.style.width)).toBeGreaterThan(parseFloat(d7.style.width))
    expect(container.querySelector('.timeline-now')).toBeInTheDocument()
  })

  it('shows a live countdown for a future next feed', async () => {
    const inTwoHours = new Date(Date.now() + 2 * 3600_000 + 14 * 60_000).toISOString()
    const { container } = render(
      <FeederCard entry={feederEntry({ next_feed_time_utc: inTwoHours })} />,
    )
    await flushEffects()
    expect(container.querySelector('.countdown')).toHaveTextContent(/^in 2h 1[34]m$/)
  })

  it('disables the feed button when offline or blocked', async () => {
    const { unmount } = render(<FeederCard entry={feederEntry({ online: false })} />)
    await flushEffects()
    expect(
      screen.getByRole('button', { name: 'Feed 1 portion' }),
    ).toBeDisabled()
    unmount()

    render(<FeederCard entry={feederEntry({ dispenser_blocked: true })} />)
    await flushEffects()
    expect(
      screen.getByRole('button', { name: 'Feed 1 portion' }),
    ).toBeDisabled()
  })

  it('arm → wait past 600ms → confirm calls api.feed(1) and shows the ✓ notice', async () => {
    vi.useFakeTimers({ toFake: [...FAKED] })
    mockFeed.mockResolvedValue({ command: 'feed', portions: 1 })
    render(<FeederCard entry={feederEntry()} />)
    await flushEffects()

    const btn = screen.getByRole('button', { name: 'Feed 1 portion' })
    fireEvent.click(btn)
    expect(btn).toHaveTextContent('Tap again to dispense')
    expect(mockFeed).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(700)
    })
    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mockFeed).toHaveBeenCalledTimes(1)
    expect(mockFeed).toHaveBeenCalledWith(1)
    expect(screen.getByText('Dispensing 1 portion ✓')).toBeInTheDocument()
    expect(btn).toHaveTextContent('Feed 1 portion') // back to idle
  })

  it('stepper + then confirm feeds 2 portions', async () => {
    vi.useFakeTimers({ toFake: [...FAKED] })
    mockFeed.mockResolvedValue({ command: 'feed', portions: 2 })
    render(<FeederCard entry={feederEntry()} />)
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: 'more portions' }))
    const btn = screen.getByRole('button', { name: 'Feed 2 portions' })
    await armAndConfirm(btn)

    expect(mockFeed).toHaveBeenCalledWith(2)
    expect(screen.getByText('Dispensing 2 portions ✓')).toBeInTheDocument()
  })

  it('clamps the stepper to 1..12', async () => {
    render(<FeederCard entry={feederEntry()} />)
    await flushEffects()

    const minus = screen.getByRole('button', { name: 'fewer portions' })
    const plus = screen.getByRole('button', { name: 'more portions' })
    expect(minus).toBeDisabled() // already at the floor of 1

    for (let i = 0; i < 15; i++) fireEvent.click(plus) // try to blow past the cap
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(plus).toBeDisabled()
    expect(minus).toBeEnabled()
  })

  it('shows the error notice with the message when api.feed rejects', async () => {
    vi.useFakeTimers({ toFake: [...FAKED] })
    mockFeed.mockRejectedValue(new Error('dispenser jam'))
    render(<FeederCard entry={feederEntry()} />)
    await flushEffects()

    const btn = screen.getByRole('button', { name: 'Feed 1 portion' })
    await armAndConfirm(btn)

    expect(mockFeed).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Feed failed: dispenser jam')).toBeInTheDocument()
    expect(btn).toBeEnabled() // ConfirmButton returned to idle after failure
  })

  // ── plug power zone (M5.5) ─────────────────────────────────────────────

  it('renders no power zone when no plug is bound', async () => {
    render(<FeederCard entry={feederEntry()} />)
    await flushEffects()
    expect(screen.queryByText('⚡ Power')).not.toBeInTheDocument()
  })

  it('renders the power zone collapsed when a plug is bound and healthy', async () => {
    render(<FeederCard entry={feederEntry()} plug={plugEntry()} />)
    await flushEffects()
    expect(screen.getByText('⚡ Power')).toBeInTheDocument()
    expect(screen.getByText('plug on')).toBeInTheDocument()
    expect(screen.queryByText('Hold to restart')).not.toBeInTheDocument()
  })

  it('says "plug is off" when the feeder is offline AND its plug reports off', async () => {
    render(
      <FeederCard
        entry={feederEntry({ online: false })}
        plug={plugEntry({ power_on: false })}
      />,
    )
    await flushEffects()
    expect(
      screen.getByText('Plug is off — that’s why the feeder is offline.'),
    ).toBeInTheDocument()
    // auto-expanded with the single restore action
    expect(screen.getByText('Hold to switch plug ON')).toBeInTheDocument()
  })
})
