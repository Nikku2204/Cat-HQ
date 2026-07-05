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

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const click = async () => {
    if (mode === 'idle') {
      setMode('armed')
      resetTimer.current = setTimeout(() => setMode('idle'), 5000)
      return
    }
    if (mode !== 'armed') return
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
