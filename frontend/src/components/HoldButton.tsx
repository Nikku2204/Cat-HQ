import { useEffect, useRef, useState } from 'react'

export const HOLD_MS = 1500

/**
 * HOLD-to-confirm (docs/05 safety rule 4) for actions that switch MAINS
 * power. Press and keep holding ≥1.5s to fire; releasing (or the pointer
 * leaving) earlier cancels. Deliberately a different gesture from the
 * two-tap ConfirmButton used by Clean/Feed — muscle memory must not carry
 * over to the red zone.
 */
export default function HoldButton({
  label,
  holdLabel = 'Keep holding…',
  onConfirm,
  disabled,
  className = 'btn hold',
}: {
  label: string
  holdLabel?: string
  onConfirm: () => Promise<void>
  disabled?: boolean
  className?: string
}) {
  const [mode, setMode] = useState<'idle' | 'holding' | 'busy'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const fired = useRef(false)

  useEffect(() => () => clearTimeout(timer.current), [])

  const cancel = () => {
    if (fired.current) return
    clearTimeout(timer.current)
    setMode((m) => (m === 'holding' ? 'idle' : m))
  }

  // If the button becomes disabled mid-hold (e.g. the plug adapter drops
  // offline while the finger is down), abort — a pointerup on a now-disabled
  // control may never arrive to cancel it otherwise.
  useEffect(() => {
    if (disabled && mode === 'holding') cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  const start = (e?: { currentTarget?: Element; pointerId?: number }) => {
    if (disabled || mode !== 'idle') return
    // Touch pointerdown implicitly captures the pointer to the button, which
    // SUPPRESSES pointerleave — so a "slide off to abort" gesture would never
    // cancel and the mains command would fire anyway. Release the capture so
    // leaving the button's bounds delivers pointerleave (→ cancel).
    const el = e?.currentTarget as (Element & {
      hasPointerCapture?: (id: number) => boolean
      releasePointerCapture?: (id: number) => void
    }) | undefined
    if (el && e?.pointerId != null) {
      try {
        if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId)
      } catch {
        /* jsdom / unsupported — pointerleave path still covers mouse */
      }
    }
    fired.current = false
    setMode('holding')
    timer.current = setTimeout(async () => {
      fired.current = true
      setMode('busy')
      try {
        await onConfirm()
      } catch {
        // surfacing errors is the caller's job (PowerZone catches in its
        // own wrapper); a stray rejection out of a timer callback would
        // otherwise become an unhandled-rejection crash
      } finally {
        setMode('idle')
      }
    }, HOLD_MS)
  }

  return (
    <button
      type="button"
      className={mode === 'holding' ? `${className} holding` : className}
      disabled={disabled || mode === 'busy'}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault()
          start()
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') cancel()
      }}
      // focus leaving mid-keyboard-hold (tab away, alt-tab) must abort — the
      // keyup that would cancel lands on another element otherwise
      onBlur={cancel}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-label">
        {mode === 'busy' ? 'Working…' : mode === 'holding' ? holdLabel : label}
      </span>
    </button>
  )
}
