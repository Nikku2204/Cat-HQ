// Care log + reminders — api module-mocked; logging a brush stroke is a DB
// write only, and even that is mocked here. No network, no hardware.
// Time is PINNED (useCare takes nowMs) so LA-day bucketing and the evening
// nudge gates are deterministic regardless of when the suite runs.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CareCard, RemindersCard, useCare } from './Care'
import { api } from '../api'
import type { DeviceEntry, EventOut } from '../types'

vi.mock('../api', () => ({ api: { events: vi.fn(), careLog: vi.fn() } }))
const eventsMock = vi.mocked(api.events)
const careLogMock = vi.mocked(api.careLog)

// 20:00Z = 13:00 LA (PDT): midday — play (≥17) and pet (≥16) nudges gated off.
const NOON = new Date('2026-07-06T20:00:00Z').getTime()
// 02:00Z next day = 19:00 LA — evening: nudges active.
const EVENING = new Date('2026-07-07T02:00:00Z').getTime()
const HOUR = 3_600_000

const careEv = (task: string, ts: number): EventOut => ({
  id: Math.floor(ts % 1e9),
  device_id: 'care',
  event_type: 'care',
  ts_utc: new Date(ts).toISOString(),
  source: 'owner',
  data: { task },
})

const litterEntry = (attrs: Record<string, unknown>): DeviceEntry => ({
  health: { status: 'ok', detail: '', last_success_utc: null, consecutive_failures: 0 },
  state: {
    device_id: 'litterrobot',
    device_type: 'litterrobot',
    fetched_at_utc: new Date(NOON).toISOString(),
    attributes: { status_code: 'RDY', is_online: true, litter_level_pct: 90, ...attrs },
  },
})

/** Harness: run the hook at a pinned instant and render both cards. */
function Harness({ litter, nowMs = NOON }: { litter?: DeviceEntry; nowMs?: number }) {
  const care = useCare(litter, undefined, nowMs)
  return (
    <>
      <RemindersCard reminders={care.reminders} />
      <CareCard statuses={care.statuses} loggedNotice={care.loggedNotice} onLog={care.log} />
    </>
  )
}

afterEach(() => vi.clearAllMocks())

describe('Care log + reminders', () => {
  it('renders all four tasks with cadence hints and Log buttons', async () => {
    eventsMock.mockResolvedValue({ count: 0, events: [] })
    render(<Harness />)
    for (const label of ['Brush his hair', 'Nail trim', 'Playtime', 'Pets']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getAllByRole('button', { name: /^Log:/ })).toHaveLength(4)
    expect(screen.getByText(/3\+ a day/)).toBeInTheDocument()
  })

  it('logging a task POSTs and refreshes; a ✓ notice appears', async () => {
    eventsMock.mockResolvedValue({ count: 0, events: [] })
    careLogMock.mockResolvedValue(careEv('brush', NOON))
    render(<Harness />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Log: Brush his hair' }))
    expect(careLogMock).toHaveBeenCalledWith('brush')
    expect(await screen.findByText(/logged ✓/)).toBeInTheDocument()
    // refetch fired (initial + after log)
    await waitFor(() => expect(eventsMock.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('a failed log shows the error and never crashes', async () => {
    eventsMock.mockResolvedValue({ count: 0, events: [] })
    careLogMock.mockRejectedValue(new Error('backend away'))
    render(<Harness />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Log: Pets' }))
    expect(await screen.findByText(/Couldn't log: backend away/)).toBeInTheDocument()
  })

  it('done-today tasks show the green check state', async () => {
    eventsMock.mockResolvedValue({
      count: 1,
      events: [careEv('brush', NOON - HOUR)],
    })
    render(<Harness />)
    expect(await screen.findByText(/done .* ✓/)).toBeInTheDocument()
  })

  it('reminders combine device needs (plain) with due care', async () => {
    eventsMock.mockResolvedValue({ count: 0, events: [] })
    render(<Harness litter={litterEntry({ litter_level_pct: 15 })} />)
    await screen.findByText(/Top up the litter \(15%\)/)
    expect(screen.getByText('Brush his hair today')).toBeInTheDocument()
  })

  it('evening: play + pets nudges join the list', async () => {
    eventsMock.mockResolvedValue({ count: 0, events: [] })
    render(<Harness nowMs={EVENING} />)
    expect(await screen.findByText('Evening playtime')).toBeInTheDocument()
    expect(screen.getByText('Pets: 0 of 3 today')).toBeInTheDocument()
  })

  it('all caught up → the cozy empty state', async () => {
    // midday + brush already logged today + healthy device = nothing due
    eventsMock.mockResolvedValue({
      count: 1,
      events: [careEv('brush', NOON - HOUR)],
    })
    render(<Harness litter={litterEntry({})} nowMs={NOON} />)
    expect(await screen.findByText(/all cozy/)).toBeInTheDocument()
  })
})
