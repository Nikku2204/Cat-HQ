// App shell (M5.5 UX v2): skeleton shimmer while the first snapshot loads,
// avatar connection ring, reconnect toast for blips, full banner only after
// 60s of continuous offline. useLive is mocked; fetch is disabled (child
// cards' event-log fetches reject and are swallowed by their .catch()).
import { act, render, screen } from '@testing-library/react'
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
    expect(screen.getByText('Litter-Robot')).toBeInTheDocument()
    expect(container.querySelector('.avatar')).toHaveClass('conn-live')
  })

  it('a live hello with zero adapters renders the not-configured cards, not skeletons', () => {
    mockUseLive.mockReturnValue({ devices: {}, conn: 'live' })
    render(<App />)
    expect(
      screen.getByText('Not configured — set WHISKER_* in .env'),
    ).toBeInTheDocument()
  })

  it('brief offline blip: no banner; reconnect shows a toast instead', async () => {
    vi.useFakeTimers()
    mockUseLive.mockReturnValue({ devices: litter, conn: 'offline' })
    const { rerender } = render(<App />)

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
