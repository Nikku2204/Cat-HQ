// PowerZone (M5.5, docs/05): the red zone only exists for a bound plug,
// stays collapsed until opened (or auto-expanded on fault), and every
// action goes through the 1.5s HoldButton before touching the api.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { api } from '../api'
import type { DeviceEntry } from '../types'
import { HOLD_MS } from './HoldButton'
import PowerZone from './PowerZone'

vi.mock('../api', () => ({
  api: {
    plugOn: vi.fn(),
    plugOff: vi.fn(),
    plugCycle: vi.fn(),
  },
}))

const mockCycle = vi.mocked(api.plugCycle)
const mockOn = vi.mocked(api.plugOn)
const mockOff = vi.mocked(api.plugOff)

function plug(
  attrs: Record<string, unknown> | null = { power_on: true, online: true },
): DeviceEntry {
  return {
    health: {
      status: 'ok',
      detail: '',
      last_success_utc: null,
      consecutive_failures: 0,
    },
    state:
      attrs === null
        ? null
        : {
            device_id: 'plug_litterrobot',
            device_type: 'plug',
            fetched_at_utc: '2026-07-05T10:00:00Z',
            attributes: attrs,
          },
  }
}

async function hold(btn: HTMLElement) {
  fireEvent.pointerDown(btn)
  await act(async () => {
    vi.advanceTimersByTime(HOLD_MS)
  })
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PowerZone', () => {
  it('renders nothing at all without a bound plug', () => {
    const { container } = render(<PowerZone plugId="plug_litterrobot" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is collapsed by default; tapping the head reveals the hold controls', () => {
    render(<PowerZone plugId="plug_litterrobot" plug={plug()} />)
    expect(screen.getByText('⚡ Power')).toBeInTheDocument()
    expect(screen.getByText('plug on')).toBeInTheDocument()
    expect(screen.queryByText('Hold to power-cycle')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /⚡ Power/ }))
    expect(screen.getByText('Hold to power-cycle')).toBeInTheDocument()
    expect(screen.getByText('Hold to switch plug OFF')).toBeInTheDocument()
  })

  it('auto-expands when autoExpand is set and shows the hint', () => {
    render(
      <PowerZone
        plugId="plug_litterrobot"
        plug={plug({ power_on: false, online: true })}
        autoExpand
        hint="Plug is off — that’s why."
      />,
    )
    expect(screen.getByText('Plug is off — that’s why.')).toBeInTheDocument()
    // plug is OFF → switching it back on is the first suggestion
    expect(screen.getByText('Hold to switch plug ON')).toBeInTheDocument()
    expect(screen.getByText('plug OFF')).toBeInTheDocument()
  })

  it('a full hold on power-cycle calls api.plugCycle with the plug id', async () => {
    vi.useFakeTimers()
    mockCycle.mockResolvedValue({ command: 'power_cycle', accepted: true, off_seconds: 8 })
    render(<PowerZone plugId="plug_litterrobot" plug={plug()} autoExpand />)

    await hold(screen.getByRole('button', { name: 'Hold to power-cycle' }))

    expect(mockCycle).toHaveBeenCalledTimes(1)
    expect(mockCycle).toHaveBeenCalledWith('plug_litterrobot')
    expect(screen.getByText('Power cycle complete ✓')).toBeInTheDocument()
    expect(mockOn).not.toHaveBeenCalled()
    expect(mockOff).not.toHaveBeenCalled()
  })

  it('the toggle hold calls plugOff when on, plugOn when off', async () => {
    vi.useFakeTimers()
    mockOff.mockResolvedValue({ command: 'power_off', accepted: true })
    const { unmount } = render(
      <PowerZone plugId="plug_litterrobot" plug={plug()} autoExpand />,
    )
    await hold(screen.getByRole('button', { name: 'Hold to switch plug OFF' }))
    expect(mockOff).toHaveBeenCalledWith('plug_litterrobot')
    unmount()

    mockOn.mockResolvedValue({ command: 'power_on', accepted: true })
    render(
      <PowerZone
        plugId="plug_litterrobot"
        plug={plug({ power_on: false, online: true })}
        autoExpand
      />,
    )
    await hold(screen.getByRole('button', { name: 'Hold to switch plug ON' }))
    expect(mockOn).toHaveBeenCalledWith('plug_litterrobot')
  })

  it('surfaces command failures (e.g. the 409 busy detail) as an error notice', async () => {
    vi.useFakeTimers()
    mockCycle.mockRejectedValue(
      new Error('a power command is already running for plug_litterrobot'),
    )
    render(<PowerZone plugId="plug_litterrobot" plug={plug()} autoExpand />)

    await hold(screen.getByRole('button', { name: 'Hold to power-cycle' }))

    expect(
      screen.getByText(/Failed: a power command is already running/),
    ).toBeInTheDocument()
  })

  it('disables the holds when the plug adapter is disconnected (state null)', () => {
    render(<PowerZone plugId="plug_litterrobot" plug={plug(null)} autoExpand />)
    expect(screen.getByText('plug unreachable')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Hold to power-cycle' }),
    ).toBeDisabled()
  })
})
