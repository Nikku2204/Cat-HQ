// Chutku's mood card — renders from live attrs + two tiny event lookups.
// api is module-mocked; nothing touches the network or hardware.
import { render, screen } from '@testing-library/react'
import MoodCard from './MoodCard'
import { api } from '../api'
import type { DeviceEntry, EventOut } from '../types'

vi.mock('../api', () => ({ api: { events: vi.fn() } }))
const eventsMock = vi.mocked(api.events)

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

const entry = (
  device_id: string,
  attributes: Record<string, unknown>,
): DeviceEntry => ({
  health: { status: 'ok', detail: '', last_success_utc: null, consecutive_failures: 0 },
  state: {
    device_id,
    device_type: device_id,
    fetched_at_utc: new Date(now).toISOString(),
    attributes,
  },
})

const ev = (
  event_type: string,
  ts_utc: string,
  data: Record<string, unknown>,
  device_id = 'litterrobot',
): EventOut => ({ id: 1, device_id, event_type, ts_utc, source: 'poll', data })

/** Route the three lookups: feed limit-1, status_change, activity. */
function seed(opts: { feed?: EventOut[]; sc?: EventOut[]; act?: EventOut[] }) {
  eventsMock.mockImplementation((p: { type?: string }) => {
    const events =
      p.type === 'feed' ? (opts.feed ?? []) : p.type === 'status_change' ? (opts.sc ?? []) : (opts.act ?? [])
    return Promise.resolve({ count: events.length, events })
  })
}

function motion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: reduce && q.includes('reduce'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

const goodLitter = () =>
  entry('litterrobot', {
    status_code: 'RDY',
    is_online: true,
    litter_level_pct: 90,
    is_waste_drawer_full: false,
    cycle_count: 6550,
  })
const goodFeeder = (extra: Record<string, unknown> = {}) =>
  entry('feeder', { online: true, today_feed_count: 4, ...extra })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('MoodCard', () => {
  it('renders nothing when no devices are configured', () => {
    seed({})
    const { container } = render(<MoodCard />)
    expect(container.firstChild).toBeNull()
  })

  it('celebrates a fresh meal with the bounce + hearts', async () => {
    motion(false)
    seed({
      feed: [ev('feed', iso(5 * 60_000), { portions: 1 }, 'feeder')],
      sc: [ev('status_change', iso(2 * 3_600_000), { to: 'CCC' })],
    })
    const { container } = render(
      <MoodCard litter={goodLitter()} feeder={goodFeeder()} />,
    )
    expect(await screen.findByText(/happiest boy alive/)).toBeInTheDocument()
    expect(container.querySelector('.mood-bounce')).toBeInTheDocument()
    expect(container.querySelector('.mood-hearts')).toBeInTheDocument()
    expect(container.querySelector('.cc')).toHaveClass('pose-happy')
  })

  it('reduced motion: still ecstatic, but no animation mounts', async () => {
    motion(true)
    seed({ feed: [ev('feed', iso(5 * 60_000), { portions: 1 }, 'feeder')] })
    const { container } = render(
      <MoodCard litter={goodLitter()} feeder={goodFeeder()} />,
    )
    expect(await screen.findByText(/happiest boy alive/)).toBeInTheDocument()
    expect(container.querySelector('.mood-bounce')).toBeNull()
    expect(container.querySelector('.mood-hearts')).toBeNull()
  })

  it('warns about the pre-dinner scam when a meal is ~30m out', async () => {
    motion(false)
    seed({ sc: [ev('status_change', iso(3_600_000), { to: 'CCC' })] })
    render(
      <MoodCard
        litter={goodLitter()}
        feeder={goodFeeder({
          next_feed_time_utc: new Date(now + 20 * 60_000).toISOString(),
        })}
      />,
    )
    expect(await screen.findByText(/It's a scam/)).toBeInTheDocument()
    expect(screen.getByText(/Don't fall for the eyes/)).toBeInTheDocument()
  })

  it('gets grumpy about a stale box with low sand, with plain actions', async () => {
    motion(false)
    seed({ sc: [ev('status_change', iso(30 * 3_600_000), { to: 'CCC' })] })
    const litter = entry('litterrobot', {
      status_code: 'RDY',
      is_online: true,
      litter_level_pct: 12,
      is_waste_drawer_full: false,
    })
    const { container } = render(<MoodCard litter={litter} feeder={goodFeeder()} />)
    expect(await screen.findByText(/UNIMPRESSED/)).toBeInTheDocument()
    expect(screen.getByText(/Top up the litter, then tap Scoop now/)).toBeInTheDocument()
    expect(container.querySelector('.cc')).toHaveClass('pose-grumpy')
  })

  it('approves of well-kept facilities', async () => {
    motion(false)
    seed({ sc: [ev('status_change', iso(2 * 3_600_000), { to: 'CCC' })] })
    render(<MoodCard litter={goodLitter()} feeder={goodFeeder()} />)
    expect(await screen.findByText(/Chutku approves/)).toBeInTheDocument()
  })

  it('a fault reads plain and points below — no cute, no animation', async () => {
    motion(false)
    seed({})
    const litter = entry('litterrobot', {
      status_code: 'PD',
      is_online: true,
      litter_level_pct: 90,
    })
    const { container } = render(<MoodCard litter={litter} />)
    expect(await screen.findByText(/hit a snag/)).toBeInTheDocument()
    expect(screen.getByText(/Check the Litter Box card below/)).toBeInTheDocument()
    expect(container.querySelector('.mood-hearts')).toBeNull()
  })

  it('failed event lookups never crash it — falls back to what live attrs say', async () => {
    motion(false)
    eventsMock.mockRejectedValue(new Error('network down'))
    render(<MoodCard litter={goodLitter()} feeder={goodFeeder()} />)
    // unknown history → never grumps; neutral line renders
    expect(await screen.findByText(/plotting his next snack/)).toBeInTheDocument()
  })
})
