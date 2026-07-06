// Tests for ConfirmButton — the two-tap guard in front of anything that moves
// real hardware (feed, clean). Spec: docs/04-TESTING.md Phase 3.
//
// Fake timers everywhere: vi.useFakeTimers also fakes Date.now, which the
// 600ms double-tap guard reads (armedAt vs Date.now()).
import { act, fireEvent, render, screen } from '@testing-library/react'
import ConfirmButton from './ConfirmButton'

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void
// The frontend tsconfig has no Node globals ("types": ["vitest/globals"]),
// so reach process via a cast — only used to contain an expected unhandled
// rejection in one test.
const proc = (
  globalThis as unknown as {
    process: {
      listeners(e: 'unhandledRejection'): RejectionListener[]
      removeAllListeners(e: 'unhandledRejection'): void
      on(e: 'unhandledRejection', l: RejectionListener): void
      off(e: 'unhandledRejection', l: RejectionListener): void
    }
  }
).process

function renderButton(over: Partial<Parameters<typeof ConfirmButton>[0]> = {}) {
  const onConfirm = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const utils = render(
    <ConfirmButton
      label="Feed now"
      confirmLabel="Really feed?"
      onConfirm={onConfirm}
      {...over}
    />,
  )
  return { ...utils, onConfirm, button: screen.getByRole('button') }
}

// Arms the button, then moves past the 600ms accidental-double-tap window.
function armAndWaitOutGuard(button: HTMLElement) {
  fireEvent.click(button)
  act(() => {
    vi.advanceTimersByTime(700)
  })
}

describe('ConfirmButton', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders idle: label, base class, enabled, onConfirm untouched', () => {
    const { button, onConfirm } = renderButton()
    expect(button).toHaveTextContent('Feed now')
    expect(button).toHaveClass('btn', 'primary')
    expect(button).not.toHaveClass('armed')
    expect(button).toBeEnabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('first click arms: confirmLabel shown, className gains "armed", no confirm yet', () => {
    const { button, onConfirm } = renderButton()
    fireEvent.click(button)
    expect(button).toHaveTextContent('Really feed?')
    expect(button).toHaveClass('btn', 'primary', 'armed')
    expect(button).toBeEnabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('ignores a second click within 600ms of arming (double-tap guard), then confirms after the window', () => {
    const { button, onConfirm } = renderButton()
    fireEvent.click(button) // arm at T

    // immediate double-tap: Date.now unchanged under fake timers → delta 0
    fireEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button).toHaveTextContent('Really feed?')
    expect(button).toHaveClass('armed')

    // still inside the window at T+599
    act(() => {
      vi.advanceTimersByTime(599)
    })
    fireEvent.click(button)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button).toHaveTextContent('Really feed?')

    // the guard is a delay, not a lockout: T+601 confirms
    act(() => {
      vi.advanceTimersByTime(2)
    })
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('confirm after >600ms: busy (Working…, disabled, called once) then back to idle on resolve', async () => {
    let resolveConfirm!: () => void
    const onConfirm = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((res) => {
          resolveConfirm = res
        }),
    )
    const { button } = renderButton({ onConfirm })

    armAndWaitOutGuard(button)
    fireEvent.click(button) // deliberate second tap → busy

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(button).toHaveTextContent('Working…')
    expect(button).toBeDisabled()

    // clicks while busy do nothing (disabled + mode guard)
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveConfirm()
    })
    expect(button).toHaveTextContent('Feed now')
    expect(button).not.toHaveClass('armed')
    expect(button).toBeEnabled()
    // 5s auto-reset timer was cleared on confirm — nothing left ticking
    expect(vi.getTimerCount()).toBe(0)
  })

  it('armed auto-resets to idle after 5s with no confirm', () => {
    const { button, onConfirm } = renderButton()
    fireEvent.click(button)

    act(() => {
      vi.advanceTimersByTime(4999)
    })
    expect(button).toHaveTextContent('Really feed?')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(button).toHaveTextContent('Feed now')
    expect(button).not.toHaveClass('armed')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('unmount while armed leaks no timer', () => {
    const { button, unmount } = renderButton()
    fireEvent.click(button)
    expect(vi.getTimerCount()).toBe(1) // the 5s auto-reset is pending
    unmount()
    expect(vi.getTimerCount()).toBe(0) // cleanup effect cleared it
  })

  it('onConfirm rejection still returns to idle (finally resets mode)', async () => {
    const err = new Error('x')
    const onConfirm = vi.fn<() => Promise<void>>().mockRejectedValue(err)

    // The component has NO catch — its finally resets mode and the error
    // rethrows out of the async click handler, which React ignores, so it
    // surfaces as an unhandled rejection. Real callers (LitterCard /
    // FeederCard) catch internally and never reject. Contain it here: swap
    // out vitest's process-level listeners for the duration so the expected
    // rejection is captured instead of reported.
    const prior = proc.listeners('unhandledRejection')
    proc.removeAllListeners('unhandledRejection')
    const captured: unknown[] = []
    const capture: RejectionListener = (reason) => {
      captured.push(reason)
    }
    proc.on('unhandledRejection', capture)

    try {
      const { button } = renderButton({ onConfirm })
      armAndWaitOutGuard(button)
      fireEvent.click(button)
      expect(button).toHaveTextContent('Working…')

      await act(async () => {}) // flush the rejection through the finally
      expect(onConfirm).toHaveBeenCalledTimes(1)
      expect(button).toHaveTextContent('Feed now')
      expect(button).toBeEnabled()

      // Node only emits 'unhandledrejection' after returning to the event
      // loop — yield real macrotasks until it lands with our capture hook.
      vi.useRealTimers()
      for (let i = 0; i < 5 && captured.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 0))
      }
      expect(captured).toEqual([err])
    } finally {
      proc.off('unhandledRejection', capture)
      for (const l of prior) proc.on('unhandledRejection', l)
    }
  })

  it('disabled prop keeps the button inert while idle', () => {
    const { button, onConfirm } = renderButton({ disabled: true })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(button).toHaveTextContent('Feed now') // never armed
    expect(button).not.toHaveClass('armed')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disabled prop keeps the button inert while armed (and the 5s reset still runs)', () => {
    const { button, onConfirm, rerender } = renderButton()
    fireEvent.click(button) // arm while enabled
    expect(button).toHaveClass('armed')

    rerender(
      <ConfirmButton
        label="Feed now"
        confirmLabel="Really feed?"
        onConfirm={onConfirm}
        disabled
      />,
    )
    expect(button).toBeDisabled()

    act(() => {
      vi.advanceTimersByTime(700) // past the double-tap window
    })
    fireEvent.click(button) // React drops clicks on disabled buttons
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button).toHaveTextContent('Really feed?') // still armed…

    act(() => {
      vi.advanceTimersByTime(4300) // …until the 5s auto-reset lands
    })
    expect(button).toHaveTextContent('Feed now')
  })
})
