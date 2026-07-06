import { useEffect, useRef, useState } from 'react'

/**
 * Two-tap confirm for buttons that move real hardware (feed, clean).
 * First tap arms it for 5s; second tap runs the action.
 */
export default function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  className = 'btn primary',
}: {
  label: string
  confirmLabel: string
  onConfirm: () => Promise<void>
  disabled?: boolean
  className?: string
}) {
  const [mode, setMode] = useState<'idle' | 'armed' | 'busy'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const armedAt = useRef(0)

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const click = async () => {
    if (mode === 'idle') {
      setMode('armed')
      armedAt.current = Date.now()
      resetTimer.current = setTimeout(() => setMode('idle'), 5000)
      return
    }
    if (mode !== 'armed') return
    // an accidental double-click/double-tap delivers its second click right
    // after arming — that must not count as deliberate confirmation
    if (Date.now() - armedAt.current < 600) return
    clearTimeout(resetTimer.current)
    setMode('busy')
    try {
      await onConfirm()
    } finally {
      setMode('idle')
    }
  }

  return (
    <button
      className={mode === 'armed' ? `${className} armed` : className}
      disabled={disabled || mode === 'busy'}
      onClick={click}
    >
      {mode === 'busy' ? 'Working…' : mode === 'armed' ? confirmLabel : label}
    </button>
  )
}
