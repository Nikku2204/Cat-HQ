// HistoryView unit tests (docs/04-TESTING.md Phase 3).
// api is module-mocked — nothing here touches the network.
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HistoryView from './HistoryView'
import { api } from '../api'
import type { EventOut } from '../types'

vi.mock('../api', () => ({
  api: { events: vi.fn() },
}))

const eventsMock = vi.mocked(api.events)
type Page = Awaited<ReturnType<typeof api.events>>

// ---- factories -------------------------------------------------------------

let nextId = 0
function ev(over: Partial<EventOut> = {}): EventOut {
  nextId += 1
  return {
    id: nextId,
    device_id: 'feeder',
    event_type: 'feed',
    ts_utc: '2026-06-30T10:00:00Z',
    source: 'poll',
    data: { portions: 2 },
    ...over,
  }
}

const page = (events: EventOut[]): Page => ({ count: events.length, events })

// Deterministic descending timestamps — newest first, like the backend returns.
const ts = (i: number) =>
  new Date(Date.UTC(2026, 5, 30, 12, 0, 0) - i * 60_000).toISOString()

// A full page (PAGE=50) of distinct activity rows: row-1 (newest) … row-50 (oldest).
const fullPage = () =>
  Array.from({ length: 50 }, (_, i) =>
    ev({ event_type: 'activity', data: { action: `row-${i + 1}` }, ts_utc: ts(i) }),
  )

beforeEach(() => {
  nextId = 0
  eventsMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---- tests -----------------------------------------------------------------

describe('HistoryView', () => {
  it('renders event rows with human descriptions', async () => {
    eventsMock.mockResolvedValueOnce(
      page([
        ev({ event_type: 'feed', data: { portions: 2 }, ts_utc: ts(0) }),
        ev({ event_type: 'feed', data: { portions: 1 }, ts_utc: ts(1) }),
        ev({
          device_id: 'litterrobot',
          event_type: 'status_change',
          data: { from: 'RDY', to: 'CCP' },
          ts_utc: ts(2),
        }),
      ]),
    )
    render(<HistoryView />)

    expect(await screen.findByText('Served 2 snacks')).toBeInTheDocument()
    expect(screen.getByText('Served 1 snack')).toBeInTheDocument() // singular
    // status arrows go through lrStatus code→text mapping
    expect(screen.getByText('Ready → Clean cycle in progress')).toBeInTheDocument()
    // device tag remaps litterrobot → litter (exact, case-sensitive: not the chip)
    expect(screen.getByText('litter')).toBeInTheDocument()
    expect(eventsMock).toHaveBeenCalledTimes(1)
    expect(eventsMock).toHaveBeenCalledWith({ device: undefined, limit: 50 })
  })

  it('filter chip refetches with the device filter and resets the list', async () => {
    eventsMock
      .mockResolvedValueOnce(page([ev({ data: { portions: 3 }, ts_utc: ts(0) })]))
      .mockResolvedValueOnce(
        page([
          ev({
            device_id: 'litterrobot',
            event_type: 'activity',
            data: { action: 'Clean Cycle' },
            ts_utc: ts(1),
          }),
        ]),
      )
    const user = userEvent.setup()
    render(<HistoryView />)
    await screen.findByText('Served 3 snacks')

    await user.click(screen.getByRole('button', { name: 'Litter' }))

    expect(await screen.findByText('Clean Cycle')).toBeInTheDocument()
    // old (All) rows are gone, not merged
    expect(screen.queryByText('Served 3 snacks')).not.toBeInTheDocument()
    expect(eventsMock).toHaveBeenCalledTimes(2)
    expect(eventsMock).toHaveBeenLastCalledWith({ device: 'litterrobot', limit: 50 })
  })

  it('drops a stale in-flight response that resolves after a filter switch', async () => {
    let resolveStale!: (p: Page) => void
    eventsMock
      .mockImplementationOnce(
        () =>
          new Promise<Page>((res) => {
            resolveStale = res
          }),
      )
      .mockResolvedValueOnce(
        page([
          ev({
            device_id: 'litterrobot',
            event_type: 'activity',
            data: { action: 'litter-row' },
            ts_utc: ts(0),
          }),
        ]),
      )
    const user = userEvent.setup()
    render(<HistoryView />)

    // switch filters while the first (All) request is still in flight
    await user.click(screen.getByRole('button', { name: 'Litter' }))
    await screen.findByText('litter-row')

    // the stale All response arrives late — the mount effect's `stale` closure
    // flag must drop it (load()'s generation guard is covered separately below)
    await act(async () => {
      resolveStale(page([ev({ data: { portions: 9 }, ts_utc: ts(1) })]))
    })
    expect(screen.queryByText('Served 9 snacks')).not.toBeInTheDocument()
    expect(screen.getByText('litter-row')).toBeInTheDocument()
  })

  it('drops a stale Load-older response that resolves after a filter switch', async () => {
    const first = fullPage() // exactly PAGE=50 → button shows
    let resolveAppend!: (p: Page) => void
    eventsMock
      .mockResolvedValueOnce(page(first))
      // the append call hangs until we resolve it below
      .mockImplementationOnce(
        () =>
          new Promise<Page>((res) => {
            resolveAppend = res
          }),
      )
      .mockResolvedValueOnce(
        page([
          ev({
            device_id: 'litterrobot',
            event_type: 'activity',
            data: { action: 'litter-row' },
            ts_utc: ts(0),
          }),
        ]),
      )
    const user = userEvent.setup()
    render(<HistoryView />)
    await screen.findByText('row-1')

    // start the append, then switch filters while it is still in flight
    await user.click(screen.getByRole('button', { name: 'Load older' }))
    await user.click(screen.getByRole('button', { name: 'Litter' }))
    await screen.findByText('litter-row')

    // the stale append arrives late — load()'s generation ref guard must drop
    // both the appended rows and the pre-switch base rows it would re-apply
    await act(async () => {
      resolveAppend(
        page([ev({ event_type: 'activity', data: { action: 'older-1' }, ts_utc: ts(50) })]),
      )
    })
    expect(screen.queryByText('older-1')).not.toBeInTheDocument()
    expect(screen.queryByText('row-1')).not.toBeInTheDocument()
    expect(screen.getByText('litter-row')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('Load older requests until=oldest ts and dedupes the inclusive boundary row', async () => {
    const first = fullPage() // exactly PAGE=50 → button shows
    const boundary = first[first.length - 1]! // row-50, the oldest
    const older = Array.from({ length: 3 }, (_, i) =>
      ev({ event_type: 'activity', data: { action: `older-${i + 1}` }, ts_utc: ts(50 + i) }),
    )
    eventsMock
      .mockResolvedValueOnce(page(first))
      // `until` is inclusive — backend sends the boundary event again
      .mockResolvedValueOnce(page([boundary, ...older]))
    const user = userEvent.setup()
    render(<HistoryView />)
    await screen.findByText('row-1')

    await user.click(screen.getByRole('button', { name: 'Load older' }))

    expect(await screen.findByText('older-3')).toBeInTheDocument()
    expect(eventsMock).toHaveBeenLastCalledWith({
      device: undefined,
      limit: 50,
      until: boundary.ts_utc,
    })
    // boundary row deduped by id — rendered exactly once
    expect(screen.getAllByText('row-50')).toHaveLength(1)
    expect(screen.getAllByRole('listitem')).toHaveLength(53)
    // the older page was short (<50) → exhausted → button hidden
    expect(screen.queryByRole('button', { name: /load older|loading/i })).not.toBeInTheDocument()
  })

  it('hides Load older when the first page is short (<50)', async () => {
    eventsMock.mockResolvedValueOnce(page([ev({ ts_utc: ts(0) })]))
    render(<HistoryView />)
    await screen.findByText('Served 2 snacks')

    expect(screen.queryByRole('button', { name: /load older|loading/i })).not.toBeInTheDocument()
    expect(eventsMock).toHaveBeenCalledTimes(1)
  })

  it('hides Load older after a full-length but all-duplicate page', async () => {
    const first = fullPage()
    eventsMock
      .mockResolvedValueOnce(page(first))
      // 50 events, every id already seen → fresh.length === 0 → exhausted
      .mockResolvedValueOnce(page(first))
    const user = userEvent.setup()
    render(<HistoryView />)
    await screen.findByText('row-1')

    await user.click(screen.getByRole('button', { name: 'Load older' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /load older|loading/i }),
      ).not.toBeInTheDocument(),
    )
    // nothing appended
    expect(screen.getAllByRole('listitem')).toHaveLength(50)
  })

  it('groups rows under Today/Yesterday headers, exactly once each and in order', async () => {
    // Pin only Date (timers stay real so findBy* works normally). Timestamps are
    // written without a zone suffix so both they and "now" parse as local time —
    // the day comparison is timezone-independent.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-05T12:00:00'))
    eventsMock.mockResolvedValueOnce(
      page([
        ev({ data: { portions: 1 }, ts_utc: '2026-07-05T10:30:00' }),
        ev({ data: { portions: 2 }, ts_utc: '2026-07-05T08:00:00' }),
        ev({ data: { portions: 3 }, ts_utc: '2026-07-04T22:15:00' }),
        ev({ data: { portions: 4 }, ts_utc: '2026-07-04T07:45:00' }),
      ]),
    )
    render(<HistoryView />)
    await screen.findByText('Served 4 snacks')

    const heads = screen.getAllByText(/^(Today|Yesterday)$/)
    expect(heads.map((h) => h.textContent)).toEqual(['Today', 'Yesterday'])
  })

  it('shows an error banner with the message when the fetch rejects', async () => {
    eventsMock.mockRejectedValueOnce(new Error('boom'))
    render(<HistoryView />)

    expect(await screen.findByText('boom')).toBeInTheDocument()
    // the empty-state line is suppressed while an error is shown
    expect(screen.queryByText('No events yet.')).not.toBeInTheDocument()
  })

  // ── M5.5 UX v2: power events, fault highlighting, Power filter ──────────

  it('renders power events distinctly for both sources (command + observed)', async () => {
    eventsMock.mockResolvedValueOnce(
      page([
        ev({
          device_id: 'plug_litterrobot',
          event_type: 'power',
          source: 'command',
          data: { command: 'power_cycle', step: 'off', delay_s: 8 },
          ts_utc: ts(0),
        }),
        ev({
          device_id: 'plug_litterrobot',
          event_type: 'power',
          source: 'command',
          data: { command: 'power_cycle', step: 'on' },
          ts_utc: ts(1),
        }),
        ev({
          device_id: 'plug_litterrobot',
          event_type: 'power',
          source: 'command',
          data: { command: 'power_on', step: 'done' },
          ts_utc: ts(2),
        }),
        ev({
          device_id: 'plug_litterrobot',
          event_type: 'power',
          source: 'poll',
          data: { field: 'power_on', from: true, to: false },
          ts_utc: ts(3),
        }),
      ]),
    )
    render(<HistoryView />)

    expect(await screen.findByText('Restart — powered off (8s)')).toBeInTheDocument()
    expect(screen.getByText('Restart — powered back on')).toBeInTheDocument()
    expect(screen.getByText('Plug switched ON')).toBeInTheDocument()
    expect(screen.getByText('Plug off (observed)')).toBeInTheDocument()
    // plug devices share one "plug" chip
    expect(screen.getAllByText('plug')).toHaveLength(4)
  })

  it('highlights fault rows red (LR fault code, failed power step)', async () => {
    eventsMock.mockResolvedValueOnce(
      page([
        ev({
          device_id: 'litterrobot',
          event_type: 'status_change',
          data: { from: 'CCP', to: 'PD' },
          ts_utc: ts(0),
        }),
        ev({
          device_id: 'plug_litterrobot',
          event_type: 'power',
          source: 'command',
          data: { command: 'power_cycle', step: 'failed', during: 'on', error: 'HTTP 500' },
          ts_utc: ts(1),
        }),
        ev({ event_type: 'feed', data: { portions: 2 }, ts_utc: ts(2) }),
      ]),
    )
    const { container } = render(<HistoryView />)

    await screen.findByText('Served 2 snacks')
    expect(container.querySelectorAll('.event-fault')).toHaveLength(2)
    expect(
      screen.getByText('Restart FAILED during on: HTTP 500'),
    ).toBeInTheDocument()
  })

  it('the Power chip filters by event type, not device', async () => {
    eventsMock
      .mockResolvedValueOnce(page([ev({ data: { portions: 3 }, ts_utc: ts(0) })]))
      .mockResolvedValueOnce(
        page([
          ev({
            device_id: 'plug_litterrobot',
            event_type: 'power',
            source: 'command',
            data: { command: 'power_off', step: 'done' },
            ts_utc: ts(1),
          }),
        ]),
      )
    const user = userEvent.setup()
    render(<HistoryView />)
    await screen.findByText('Served 3 snacks')

    await user.click(screen.getByRole('button', { name: 'Power' }))

    expect(await screen.findByText('Plug switched OFF')).toBeInTheDocument()
    expect(eventsMock).toHaveBeenLastCalledWith({ type: 'power', limit: 50 })
  })
})

describe('HistoryView deep-link (M5.7 Den tiles)', () => {
  it('initialFilter pre-selects the chip and scopes the first fetch', async () => {
    eventsMock.mockResolvedValueOnce(
      page([ev({ device_id: 'litterrobot', event_type: 'activity', data: { action: 'Cat Detected' } })]),
    )
    render(<HistoryView initialFilter="litterrobot" />)
    await screen.findByText('Cat Detected')
    expect(eventsMock).toHaveBeenCalledWith({ device: 'litterrobot', limit: 50 })
    expect(screen.getByRole('button', { name: 'Litter' })).toHaveClass('active')
  })

  it('defaults to All when no initialFilter is given', async () => {
    eventsMock.mockResolvedValueOnce(page([ev()]))
    render(<HistoryView />)
    await screen.findByText('Served 2 snacks')
    expect(eventsMock).toHaveBeenCalledWith({ limit: 50 })
    expect(screen.getByRole('button', { name: 'All' })).toHaveClass('active')
  })
})

describe('Diary icons (owner request 2026-07-06)', () => {
  it('litter activities get meaning-specific icons', async () => {
    eventsMock.mockResolvedValueOnce(
      page([
        ev({ device_id: 'litterrobot', event_type: 'activity', data: { action: 'Cat Detected' }, ts_utc: ts(0) }),
        ev({ device_id: 'litterrobot', event_type: 'activity', data: { action: 'Clean Cycle Complete' }, ts_utc: ts(1) }),
        ev({ device_id: 'litterrobot', event_type: 'activity', data: { action: 'Clean Cycle In Progress' }, ts_utc: ts(2) }),
        ev({ device_id: 'litterrobot', event_type: 'activity', data: { action: 'Pet Weight Recorded: 13.0 lbs' }, ts_utc: ts(3) }),
        ev({ device_id: 'litterrobot', event_type: 'activity', data: { action: 'Clean Cycles: 6548' }, ts_utc: ts(4) }),
      ]),
    )
    const { container } = render(<HistoryView />)
    await screen.findByText('Cat Detected')
    const icons = [...container.querySelectorAll('.evicon')].map((el) => el.textContent)
    expect(icons).toEqual(['🐈', '✨', '🌀', '⚖️', '♻️'])
  })

  it('status transitions get an icon for where they landed', async () => {
    eventsMock.mockResolvedValueOnce(
      page([
        ev({ device_id: 'litterrobot', event_type: 'status_change', data: { from: 'CCP', to: 'RDY' }, ts_utc: ts(0) }),
        ev({ device_id: 'litterrobot', event_type: 'status_change', data: { from: 'RDY', to: 'CCP' }, ts_utc: ts(1) }),
        ev({ device_id: 'litterrobot', event_type: 'status_change', data: { from: 'RDY', to: 'PD' }, ts_utc: ts(2) }),
      ]),
    )
    const { container } = render(<HistoryView />)
    await screen.findByText(/Ready → Clean cycle in progress/)
    const icons = [...container.querySelectorAll('.evicon')].map((el) => el.textContent)
    expect(icons).toEqual(['✅', '🌀', '⚠️'])
  })

  it('power ON is a green tile, OFF a red one; connectivity matches', async () => {
    eventsMock.mockResolvedValueOnce(
      page([
        ev({ device_id: 'plug_feeder', event_type: 'power', source: 'command', data: { command: 'power_on', step: 'done' }, ts_utc: ts(0) }),
        ev({ device_id: 'plug_feeder', event_type: 'power', source: 'command', data: { command: 'power_off', step: 'done' }, ts_utc: ts(1) }),
        ev({ device_id: 'feeder', event_type: 'connectivity', data: { to: false }, ts_utc: ts(2) }),
        ev({ device_id: 'feeder', event_type: 'connectivity', data: { to: true }, ts_utc: ts(3) }),
      ]),
    )
    const { container } = render(<HistoryView />)
    await screen.findByText('Plug switched ON')
    const tiles = [...container.querySelectorAll('.evicon')]
    expect(tiles[0]).toHaveClass('ev-on') // switched ON → green
    expect(tiles[1]).toHaveClass('ev-off') // switched OFF → red
    expect(tiles[2]).toHaveClass('ev-off') // went offline → red
    expect(tiles[2].textContent).toBe('📵')
    expect(tiles[3]).toHaveClass('ev-on') // back online → green
    expect(tiles[3].textContent).toBe('📶')
  })
})
