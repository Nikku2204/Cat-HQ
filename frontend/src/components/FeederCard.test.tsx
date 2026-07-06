// docs/04-TESTING.md Phase 3 — FeederCard: not-configured placeholder,
// "No data — <detail>" fallback, three independent warning banners
// (offline / dispenser_blocked / food_low), feed happy path through the
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
    expect(
      screen.getByText(`${fmtTime('2026-07-05T17:00:00Z')} · 2p`),
    ).toBeInTheDocument()

    expect(mockEvents).toHaveBeenCalledWith({
      device: 'feeder',
      type: 'feed',
      limit: 1,
    })

    // Healthy: no banners, button enabled
    expect(
      screen.queryByText('Feeder offline — check power/wifi'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Dispenser blocked!')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Food low — refill the hopper'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Feed 1 portion' })).toBeEnabled()
  })

  it('renders only the offline banner when online is false', async () => {
    render(<FeederCard entry={feederEntry({ online: false })} />)
    await flushEffects()
    expect(
      screen.getByText('Feeder offline — check power/wifi'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Dispenser blocked!')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Food low — refill the hopper'),
    ).not.toBeInTheDocument()
  })

  it('renders only the blocked banner when dispenser_blocked is true', async () => {
    render(<FeederCard entry={feederEntry({ dispenser_blocked: true })} />)
    await flushEffects()
    expect(screen.getByText('Dispenser blocked!')).toBeInTheDocument()
    expect(
      screen.queryByText('Feeder offline — check power/wifi'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Food low — refill the hopper'),
    ).not.toBeInTheDocument()
  })

  it('renders only the food-low banner when food_low is true', async () => {
    render(<FeederCard entry={feederEntry({ food_low: true })} />)
    await flushEffects()
    expect(screen.getByText('Food low — refill the hopper')).toBeInTheDocument()
    expect(
      screen.queryByText('Feeder offline — check power/wifi'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Dispenser blocked!')).not.toBeInTheDocument()
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
})
