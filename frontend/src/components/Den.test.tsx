// The Den renders entirely from seeded /events + live device attrs. api.events
// is mocked (no network, no cloud, no hardware — docs/04 rules). matchMedia is
// forced to reduced-motion so the goal ring mounts filled (deterministic, and
// no stray rAF act() warnings).
import { render, screen } from '@testing-library/react'
import Den from './Den'
import { api } from '../api'
import type { Devices, EventOut } from '../types'

vi.mock('../api', () => ({ api: { events: vi.fn() } }))
const mockEvents = vi.mocked(api.events)

const DAY = 86_400_000
const now = Date.now()

const ev = (
  event_type: string,
  ts: number,
  data: Record<string, unknown>,
  device_id = 'litterrobot',
): EventOut => ({
  id: Math.floor(ts),
  device_id,
  event_type,
  ts_utc: new Date(ts).toISOString(),
  source: 'poll',
  data,
})

/** Route api.events(params) → the matching seeded array. */
function seed(byType: Partial<Record<string, EventOut[]>>) {
  mockEvents.mockImplementation((params: { type?: string }) =>
    Promise.resolve({
      count: byType[params.type ?? '']?.length ?? 0,
      events: byType[params.type ?? ''] ?? [],
    }),
  )
}

const litterDevice = (attrs: Record<string, unknown>): Devices['x'] => ({
  health: { status: 'ok', detail: '', last_success_utc: null, consecutive_failures: 0 },
  state: {
    device_id: 'litterrobot',
    device_type: 'litterrobot',
    fetched_at_utc: new Date(now).toISOString(),
    attributes: {
      status_code: 'RDY',
      status_text: 'Ready',
      is_online: true,
      cycle_count: 6544,
      ...attrs,
    },
  },
})

const feederDevice = (attrs: Record<string, unknown>): Devices['x'] => ({
  health: { status: 'ok', detail: '', last_success_utc: null, consecutive_failures: 0 },
  state: {
    device_id: 'feeder',
    device_type: 'feeder',
    fetched_at_utc: new Date(now).toISOString(),
    attributes: { online: true, today_feed_count: 3, ...attrs },
  },
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Den — empty', () => {
  it('shows the friendly placeholder when no devices are connected', () => {
    seed({})
    render(<Den devices={{}} />)
    expect(screen.getByText('🌙 The Den')).toBeInTheDocument()
    expect(screen.getByText(/fills in as Cat HQ watches/)).toBeInTheDocument()
  })
})

describe('Den — cold start (DB only days deep)', () => {
  it('renders honest "still learning" states and a single meals ring', async () => {
    // one weigh-in today, no history at all
    seed({ pet_weight: [ev('pet_weight', now - 3_600_000, { to: 13.2 })] })
    const devices: Devices = {
      litterrobot: litterDevice({ pet_weight_lbs: 13.2 }),
      feeder: feederDevice({ next_feed_time_utc: new Date(now + 5_400_000).toISOString() }),
    }
    const { container } = render(<Den devices={devices} />)

    // hero always renders
    expect(screen.getByText('Pinsu')).toBeInTheDocument()

    // weight watch is in its cold-start state (fewer than 4 weigh-ins)
    expect(
      await screen.findByText(/Still learning Pinsu's normal/),
    ).toBeInTheDocument()
    // and it states the owner-provided healthy range
    expect(screen.getByText(/12\.5–14 lb/)).toBeInTheDocument()

    // visits tile: no baseline yet
    expect(screen.getByText('still learning her routine')).toBeInTheDocument()

    // single meals goal ring on a cold DB (owner Q4: no visits ring yet)
    expect(container.querySelectorAll('.goalring-arc')).toHaveLength(1)
  })

  it('the weight chip reads in-range when inside the seed band', async () => {
    seed({})
    const devices: Devices = { litterrobot: litterDevice({ pet_weight_lbs: 13.2 }) }
    render(<Den devices={devices} />)
    expect(await screen.findAllByText('in range')).not.toHaveLength(0)
  })
})

describe('Den — a populated day', () => {
  function populated(): Devices {
    const petWeight: EventOut[] = []
    const activity: EventOut[] = []
    const feed: EventOut[] = []
    // 9 days of history → a 7-day baseline exists.
    for (let d = 8; d >= 0; d--) {
      const base = now - d * DAY
      petWeight.push(ev('pet_weight', base - 6 * 3600_000, { to: 13.2 }))
      petWeight.push(ev('pet_weight', base - 2 * 3600_000, { to: 13.1 }))
      activity.push(
        ev('activity', base - 5 * 3600_000, { action: 'Cat Detected' }),
      )
      if (d > 0) {
        for (let i = 0; i < 4; i++) {
          feed.push(
            ev('feed', base - i * 3600_000, { portions: 1 }, 'feeder'),
          )
        }
      }
    }
    seed({ pet_weight: petWeight, activity, feed })
    return {
      litterrobot: litterDevice({ pet_weight_lbs: 13.2 }),
      feeder: feederDevice({
        today_feed_count: 3,
        next_feed_time_utc: new Date(now + 5_400_000).toISOString(),
      }),
    }
  }

  it('shows the visits ring (two arcs) and the weight trend chart', async () => {
    const { container } = render(<Den devices={populated()} />)

    // weight watch draws its chart once enough weigh-ins exist
    const chart = await screen.findByRole('img', { name: /Weight over 30 days/ })
    expect(chart).toBeInTheDocument()
    expect(chart.querySelector('.den-band')).toBeInTheDocument()
    expect(chart.querySelector('.den-wmed')).toBeInTheDocument()

    // both goal rings render once a visit baseline exists
    expect(container.querySelectorAll('.goalring-arc')).toHaveLength(2)
  })

  it('the 90d toggle re-scopes the weight chart', async () => {
    render(<Den devices={populated()} />)
    const toggle = await screen.findByRole('button', { name: '90d' })
    const user = (await import('@testing-library/user-event')).default.setup()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('the meal countdown renders from the live next-feed time', async () => {
    render(<Den devices={populated()} />)
    // "next in 1h 30m" — the exact minute drifts, so match the shape
    expect(await screen.findByText(/next in \dh/)).toBeInTheDocument()
  })
})

describe('Den — an outage is never a sad Pinsu', () => {
  it('renders factually and keeps the mascot neutral when a device is offline', async () => {
    seed({})
    const devices: Devices = {
      litterrobot: litterDevice({ pet_weight_lbs: 13.2, is_online: false }),
      feeder: feederDevice({ online: false }),
    }
    const { container } = render(<Den devices={devices} />)
    expect(await screen.findByText(/a device is offline/)).toBeInTheDocument()
    // neutral mood → awake pose, never a distressed variant
    expect(container.querySelector('.den-mood .pixel-cat')).toHaveClass('pose-awake')
  })
})
