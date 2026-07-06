import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../format'

/** Number that tweens to its new value on change (docs/05 Part B item 4).
 * Jumps straight there under prefers-reduced-motion. */
export default function TickNumber({
  value,
  decimals = 0,
  suffix = '',
}: {
  value: number | null | undefined
  decimals?: number
  suffix?: string
}) {
  const [disp, setDisp] = useState<number | null | undefined>(value)
  const prev = useRef<number | null | undefined>(value)

  useEffect(() => {
    const from = prev.current
    const to = value
    prev.current = value
    if (
      to == null ||
      from == null ||
      from === to ||
      prefersReducedMotion() ||
      typeof requestAnimationFrame === 'undefined'
    ) {
      setDisp(to)
      return
    }
    const t0 = performance.now()
    const dur = 500
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const eased = 1 - (1 - k) ** 3
      setDisp(from + (to - from) * eased)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return (
    <>
      {disp == null ? '—' : `${disp.toFixed(decimals)}${suffix}`}
    </>
  )
}
