// docs/04-TESTING.md Phase 3 — LitterCard: not-configured placeholder,
// "No data — <detail>" fallback, offline pill, clean happy path (real
// ConfirmButton two-tap flow under fake timers), failure notice, disabled
// matrix (CCP / offline), and "Last cycle" derived from the event log.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { api } from '../api'
import { fmtDayTime } from '../format'
import type { AdapterHealth, DeviceEntry, EventOut, LitterAttrs } from '../types'
import LitterCard from './LitterCard'

vi.mock('../api', () => ({
  api: {
    devices: vi.fn(),
    clean: vi.fn(),
    feed: vi.fn(),
    events: vi.fn(),
  },
}))

const mockEvents = vi.mocked(api.events)
const mockClean = vi.mocked(api.clean)

function health(overrides: Partial<AdapterHealth> = {}): AdapterHealth {
  return {
    status: 'ok',
    detail: '',
    last_success_utc: null,
    consecutive_failures: 0,
    ...overrides,
  }
}

function litterEntry(
  attrOverrides: Partial<LitterAttrs> = {},
  healthOverrides: Partial<AdapterHealth> = {},
): DeviceEntry {
  const attrs: LitterAttrs = {
    status_code: 'RDY',
    status_text: 'Ready',
    waste_drawer_level_pct: 40,
    litter_level_pct: 70,
    is_waste_drawer_full: false,
    is_online: true,
    cycle_count: 123,
    pet_weight_lbs: 9.4,
    last_seen_utc: '2026-07-05T09:00:00Z',
    ...attrOverrides,
  }
  return {
    health: health(healthOverrides),
    state: {
      device_id: 'litterrobot',
      device_type: 'litterrobot',
      fetched_at_utc: '2026-07-05T10:00:00Z',
      attributes: { ...attrs },
    },
  }
}

function evt(overrides: Partial<EventOut> = {}): EventOut {
  return {
    id: 1,
    device_id: 'litterrobot',
    event_type: 'status_change',
    ts_utc: '2026-07-05T10:00:00Z',
    source: 'poll',
    data: { from: 'CCP', to: 'CCC' },
    ...overrides,
  }
}

// Flush the mount effect's Promise.all so setLastCycle lands inside act.
const flushEffects = () => act(async () => {})

// The 600ms double-tap arm delay and the 5s auto-reset both read the (faked)
// clock; Date must be in toFake or the second tap is treated as accidental.
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

describe('LitterCard', () => {
  it('shows the not-configured placeholder and skips the event fetch when no entry', () => {
    render(<LitterCard />)
    expect(
      screen.getByText('Not configured — set WHISKER_* in .env'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(mockEvents).not.toHaveBeenCalled()
  })

  it('shows "No data — <detail>" when state is null', async () => {
    render(
      <LitterCard
        entry={{
          health: health({ status: 'error', detail: 'login failed' }),
          state: null,
        }}
      />,
    )
    await flushEffects()
    expect(screen.getByText('No data — login failed')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument() // HealthBadge
  })

  it('defaults to "adapter disconnected" when health.detail is empty', async () => {
    render(
      <LitterCard entry={{ health: health({ status: 'degraded' }), state: null }} />,
    )
    await flushEffects()
    expect(screen.getByText('No data — adapter disconnected')).toBeInTheDocument()
  })

  it('renders status, bars, meta and health from attrs and queries both event types', async () => {
    render(<LitterCard entry={litterEntry()} />)
    await flushEffects()

    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('ok')).toBeInTheDocument() // HealthBadge
    expect(screen.queryByText('offline')).not.toBeInTheDocument()

    // Bars render for real
    expect(screen.getByText('Waste drawer')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.getByText('Litter level')).toBeInTheDocument()
    expect(screen.getByText('70%')).toBeInTheDocument()

    expect(screen.getByText('123')).toBeInTheDocument() // lifetime cycles
    expect(screen.getByText('9.4 lb')).toBeInTheDocument()

    // Two type-filtered queries via Promise.all
    expect(mockEvents).toHaveBeenCalledTimes(2)
    expect(mockEvents).toHaveBeenCalledWith({
      device: 'litterrobot',
      type: 'status_change',
      limit: 20,
    })
    expect(mockEvents).toHaveBeenCalledWith({
      device: 'litterrobot',
      type: 'activity',
      limit: 20,
    })

    // No clean-cycle event in the log yet
    expect(screen.getByText('Last cycle').nextElementSibling).toHaveTextContent('—')

    expect(
      screen.getByRole('button', { name: 'Start clean cycle' }),
    ).toBeEnabled()
  })

  it('renders "Last cycle" from the newest clean-cycle event across both queries', async () => {
    const olderCcc = evt({ id: 1, ts_utc: '2026-07-04T08:00:00Z' })
    const nonCycle = evt({
      id: 2,
      ts_utc: '2026-07-05T09:30:00Z',
      data: { from: 'CCC', to: 'RDY' },
    })
    const newest = evt({
      id: 3,
      event_type: 'activity',
      ts_utc: '2026-07-05T06:15:00Z',
      source: 'history',
      data: { action: 'Clean Cycle Complete' },
    })
    mockEvents.mockImplementation((params) =>
      Promise.resolve(
        params.type === 'status_change'
          ? { count: 2, events: [nonCycle, olderCcc] }
          : { count: 1, events: [newest] },
      ),
    )

    render(<LitterCard entry={litterEntry()} />)

    // Newest cycle event wins: the 06:15 activity beats yesterday's CCC,
    // and the RDY transition is filtered out entirely.
    expect(
      await screen.findByText(fmtDayTime('2026-07-05T06:15:00Z')),
    ).toBeInTheDocument()
  })

  it('shows the offline pill and disables the button when is_online is false', async () => {
    render(<LitterCard entry={litterEntry({ is_online: false })} />)
    await flushEffects()
    expect(screen.getByText('offline')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Start clean cycle' }),
    ).toBeDisabled()
  })

  it('relabels and disables the button while cycling (status_code CCP)', async () => {
    render(
      <LitterCard
        entry={litterEntry({
          status_code: 'CCP',
          status_text: 'Clean cycle in progress',
        })}
      />,
    )
    await flushEffects()
    expect(
      screen.getByRole('button', { name: 'Cycle in progress…' }),
    ).toBeDisabled()
  })

  it('arm → wait past 600ms → confirm calls api.clean and shows the ✓ notice', async () => {
    vi.useFakeTimers({ toFake: [...FAKED] })
    mockClean.mockResolvedValue({ command: 'clean', accepted: true })
    render(<LitterCard entry={litterEntry()} />)
    await flushEffects()

    const btn = screen.getByRole('button', { name: 'Start clean cycle' })
    fireEvent.click(btn)
    expect(btn).toHaveTextContent('Tap again to cycle the globe')
    expect(mockClean).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(700)
    })
    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mockClean).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Clean cycle started ✓')).toBeInTheDocument()
    expect(btn).toHaveTextContent('Start clean cycle') // back to idle
  })

  it('shows the error notice with the message when api.clean rejects', async () => {
    vi.useFakeTimers({ toFake: [...FAKED] })
    mockClean.mockRejectedValue(new Error('whisker cloud 502'))
    render(<LitterCard entry={litterEntry()} />)
    await flushEffects()

    const btn = screen.getByRole('button', { name: 'Start clean cycle' })
    await armAndConfirm(btn)

    expect(mockClean).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText('Clean failed: whisker cloud 502'),
    ).toBeInTheDocument()
    expect(btn).toBeEnabled() // ConfirmButton returned to idle after failure
  })
})
