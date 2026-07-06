// HoldButton (M5.5, docs/05 safety rule 4): mains actions require a real
// ≥1.5s hold. Releasing early, leaving the button, or a plain tap must
// never fire. jsdom pointer events + fake timers.
import { act, fireEvent, render, screen } from '@testing-library/react'
import HoldButton, { HOLD_MS } from './HoldButton'

const flush = () => act(async () => {})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('HoldButton', () => {
  it('fires only after the full hold, then returns to idle', async () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<HoldButton label="Hold me" onConfirm={onConfirm} />)
    const btn = screen.getByRole('button')

    fireEvent.pointerDown(btn)
    expect(btn).toHaveTextContent('Keep holding…')

    act(() => {
      vi.advanceTimersByTime(HOLD_MS - 100) // almost there…
    })
    expect(onConfirm).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(100) // …now it fires
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await flush()
    expect(btn).toHaveTextContent('Hold me') // back to idle
  })

  it('releasing before 1.5s cancels without firing', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<HoldButton label="Hold me" onConfirm={onConfirm} />)
    const btn = screen.getByRole('button')

    fireEvent.pointerDown(btn)
    act(() => {
      vi.advanceTimersByTime(HOLD_MS - 100)
    })
    fireEvent.pointerUp(btn) // let go too early
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(btn).toHaveTextContent('Hold me')
  })

  it('the pointer sliding off the button cancels the hold', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<HoldButton label="Hold me" onConfirm={onConfirm} />)
    const btn = screen.getByRole('button')

    fireEvent.pointerDown(btn)
    fireEvent.pointerLeave(btn)
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2)
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('shows Working… while the confirm promise is pending and disables itself', async () => {
    vi.useFakeTimers()
    let resolveConfirm!: () => void
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveConfirm = res
        }),
    )
    render(<HoldButton label="Hold me" onConfirm={onConfirm} />)
    const btn = screen.getByRole('button')

    fireEvent.pointerDown(btn)
    await act(async () => {
      vi.advanceTimersByTime(HOLD_MS)
    })
    expect(btn).toHaveTextContent('Working…')
    expect(btn).toBeDisabled()

    await act(async () => {
      resolveConfirm()
    })
    expect(btn).toHaveTextContent('Hold me')
    expect(btn).toBeEnabled()
  })

  it('returns to idle even when the confirm rejects', async () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockRejectedValue(new Error('cloud down'))
    render(<HoldButton label="Hold me" onConfirm={onConfirm} />)
    const btn = screen.getByRole('button')

    fireEvent.pointerDown(btn)
    await act(async () => {
      vi.advanceTimersByTime(HOLD_MS)
    })
    await flush()
    expect(btn).toHaveTextContent('Hold me')
    expect(btn).toBeEnabled()
  })

  it('does nothing when disabled', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<HoldButton label="Hold me" onConfirm={onConfirm} disabled />)
    const btn = screen.getByRole('button')

    fireEvent.pointerDown(btn)
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2)
    })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(btn).toHaveTextContent('Hold me')
  })

  it('supports keyboard holds (keydown → keyup early = cancel)', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<HoldButton label="Hold me" onConfirm={onConfirm} />)
    const btn = screen.getByRole('button')

    fireEvent.keyDown(btn, { key: 'Enter' })
    expect(btn).toHaveTextContent('Keep holding…')
    fireEvent.keyUp(btn, { key: 'Enter' })
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2)
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('focus leaving mid-keyboard-hold cancels (blur), so nothing fires', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<HoldButton label="Hold me" onConfirm={onConfirm} />)
    const btn = screen.getByRole('button')

    fireEvent.keyDown(btn, { key: 'Enter' }) // start a keyboard hold
    expect(btn).toHaveTextContent('Keep holding…')
    fireEvent.blur(btn) // focus moves away (tab/alt-tab) before the 1.5s
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2)
    })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(btn).toHaveTextContent('Hold me')
  })

  it('becoming disabled mid-hold aborts the pending mains command', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <HoldButton label="Hold me" onConfirm={onConfirm} disabled={false} />,
    )
    const btn = screen.getByRole('button')

    fireEvent.pointerDown(btn)
    expect(btn).toHaveTextContent('Keep holding…')
    // e.g. the plug adapter drops offline while the finger is still down
    rerender(<HoldButton label="Hold me" onConfirm={onConfirm} disabled />)
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2)
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('releases implicit pointer capture on pointerdown so slide-off can cancel', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<HoldButton label="Hold me" onConfirm={onConfirm} />)
    const btn = screen.getByRole('button')
    // jsdom has no real pointer capture; stub it to assert we RELEASE on down
    const released: number[] = []
    ;(btn as unknown as { hasPointerCapture: (id: number) => boolean }).hasPointerCapture =
      () => true
    ;(btn as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
      (id: number) => released.push(id)

    fireEvent.pointerDown(btn, { pointerId: 7 })
    expect(released).toEqual([7])
    // then a slide-off (pointerleave) cancels the hold as normal
    fireEvent.pointerLeave(btn)
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2)
    })
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
