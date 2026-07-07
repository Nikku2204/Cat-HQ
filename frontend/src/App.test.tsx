// App shell (M5.5 UX v2): skeleton shimmer while the first snapshot loads,
// avatar connection ring, reconnect toast for blips, full banner only after
// 60s of continuous offline. useLive is mocked; fetch is disabled (child
// cards' event-log fetches reject and are swallowed by their .catch()).
import { act, fireEvent, render, screen } from '@testing-library/react'
import App from './App'
import { useLive } from './useLive'
import type { Devices } from './types'

vi.mock('./useLive', () => ({ useLive: vi.fn() }))
const mockUseLive = vi.mocked(useLive)

const litter: Devices = {
  litterrobot: {
    health: { status: 'ok', detail: '', last_success_utc: null, consecutive_failures: 0 },
    state: {
      device_id: 'litterrobot',
      device_type: 'litterrobot',
      fetched_at_utc: '2026-07-05T10:00:00Z',
      attributes: { status_code: 'RDY', status_text: 'Ready', is_online: true },
    },
  },
}

beforeEach(() => {
  localStorage.setItem('cathq_token', 'test-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('network disabled in tests'))),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('App shell', () => {
  it('shows skeleton cards while connecting with no snapshot yet', () => {
    mockUseLive.mockReturnValue({ devices: {}, conn: 'connecting' })
    const { container } = render(<App />)
    expect(container.querySelectorAll('.card.skeleton')).toHaveLength(2)
    expect(container.querySelector('.avatar')).toHaveClass('conn-connecting')
  })

  it('renders real cards once devices arrive, avatar ring goes live', () => {
    mockUseLive.mockReturnValue({ devices: litter, conn: 'live' })
    const { container } = render(<App />)
    expect(container.querySelectorAll('.card.skeleton')).toHaveLength(0)
    expect(screen.getByText('🚽 Litter Box')).toBeInTheDocument()
    expect(container.querySelector('.avatar')).toHaveClass('conn-live')
  })

  it('a live hello with zero adapters renders the not-configured cards, not skeletons', () => {
    mockUseLive.mockReturnValue({ devices: {}, conn: 'live' })
    render(<App />)
    expect(
      screen.getByText('No litter box yet — set WHISKER_* in .env'),
    ).toBeInTheDocument()
  })

  it('brief blip after being live: no banner; reconnect shows a toast', async () => {
    vi.useFakeTimers()
    // must have been live first — a reconnect toast only makes sense after a
    // real prior connection (a slow first connect is "connecting", not this)
    mockUseLive.mockReturnValue({ devices: litter, conn: 'live' })
    const { rerender } = render(<App />)

    mockUseLive.mockReturnValue({ devices: litter, conn: 'offline' })
    rerender(<App />)
    // 10s of offline — well under the 60s threshold → no banner
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument()

    mockUseLive.mockReturnValue({ devices: litter, conn: 'live' })
    rerender(<App />)
    expect(screen.getByText('Reconnected ✓')).toBeInTheDocument()

    // the toast dismisses itself
    act(() => {
      vi.advanceTimersByTime(3500)
    })
    expect(screen.queryByText('Reconnected ✓')).not.toBeInTheDocument()
  })

  it('a slow first connect (never live before) shows no reconnect toast', () => {
    vi.useFakeTimers()
    mockUseLive.mockReturnValue({ devices: {}, conn: 'connecting' })
    const { rerender } = render(<App />)
    mockUseLive.mockReturnValue({ devices: litter, conn: 'live' })
    rerender(<App />)
    expect(screen.queryByText('Reconnected ✓')).not.toBeInTheDocument()
  })

  it('long-offline banner survives reconnect churn (offline↔connecting)', () => {
    vi.useFakeTimers()
    // the WS cycles offline→connecting→offline during a real outage; the 60s
    // banner clock must NOT reset on each 'connecting' attempt
    mockUseLive.mockReturnValue({ devices: litter, conn: 'offline' })
    const { rerender } = render(<App />)
    act(() => vi.advanceTimersByTime(30_000))
    mockUseLive.mockReturnValue({ devices: litter, conn: 'connecting' })
    rerender(<App />)
    act(() => vi.advanceTimersByTime(20_000))
    mockUseLive.mockReturnValue({ devices: litter, conn: 'offline' })
    rerender(<App />)
    // 30 + 20 = 50s elapsed, still under 60 → no banner yet
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(11_000))
    // 61s of continuous not-live → banner, despite the 'connecting' churn
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument()
  })

  it('reconnect toast is not stranded if the connection drops again within 3s', () => {
    vi.useFakeTimers()
    mockUseLive.mockReturnValue({ devices: litter, conn: 'live' })
    const { rerender } = render(<App />)
    mockUseLive.mockReturnValue({ devices: litter, conn: 'offline' })
    rerender(<App />)
    mockUseLive.mockReturnValue({ devices: litter, conn: 'live' })
    rerender(<App />)
    expect(screen.getByText('Reconnected ✓')).toBeInTheDocument()
    // drops again 1s later (its own dismiss timer must still fire)
    act(() => vi.advanceTimersByTime(1_000))
    mockUseLive.mockReturnValue({ devices: litter, conn: 'offline' })
    rerender(<App />)
    act(() => vi.advanceTimersByTime(2_500))
    expect(screen.queryByText('Reconnected ✓')).not.toBeInTheDocument()
  })

  it('the 🌙 Den tab renders the insights dashboard', async () => {
    // reduced-motion → the goal ring mounts filled (no rAF act churn); the
    // child cards' event fetches reject (fetch is disabled) and Den falls back
    // to its cold-start states, but the hero always renders.
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })),
    )
    mockUseLive.mockReturnValue({ devices: litter, conn: 'live' })
    render(<App />)
    fireEvent.click(screen.getByText('🌙 Den'))
    expect(await screen.findByText('Chutku')).toBeInTheDocument()
    expect(screen.getByText('Weight watch')).toBeInTheDocument()
  })

  it('shows the full banner only after 60s of continuous offline', () => {
    vi.useFakeTimers()
    mockUseLive.mockReturnValue({ devices: litter, conn: 'offline' })
    render(<App />)

    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1_500)
    })
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument()
  })
})
