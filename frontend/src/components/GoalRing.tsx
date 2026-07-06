import { useEffect, useState, type ReactNode } from 'react'
import { clamp01 } from '../insights'
import { prefersReducedMotion } from '../format'

// Apple-Fitness-style percent-fill goal ring(s) — a NEW primitive (docs/06
// T2). Deliberately NOT Ring.tsx: that's a *status* ring (ok/busy/bad/off CSS
// sweep). This is a bounded percent arc from the circumference formula:
//   C = 2πr ;  stroke-dashoffset = C·(1−pct)  (clamped ≥ 0)
// rotated −90° to start at 12 o'clock, round caps, over-100% draws a second
// faint arc so an overshoot still reads. One or two concentric rings; the
// center holds Pinsu's photo / the mood mascot.
//
// The fill animates via a mount toggle + CSS transition (reliable on iOS
// Safari, and later value changes transition smoothly too). Reduced-motion
// mounts already-filled with no transition (styles.css).

export interface RingSpec {
  pct: number
  /** any CSS color (usually a var like 'var(--accent)') */
  color: string
  /** for the accessible <desc>, e.g. "Visits 4 of 5" */
  label: string
  glow?: boolean
}

export default function GoalRing({
  rings,
  size = 128,
  stroke = 8,
  gap = 7,
  title = 'Daily goals',
  children,
}: {
  rings: RingSpec[]
  size?: number
  stroke?: number
  gap?: number
  title?: string
  children?: ReactNode
}) {
  // Start empty, fill in after mount so the CSS transition runs. Reduced-motion
  // starts filled (the media query also kills the transition).
  const [filled, setFilled] = useState(() => prefersReducedMotion())
  useEffect(() => {
    if (filled) return
    const raf = requestAnimationFrame(() => setFilled(true))
    return () => cancelAnimationFrame(raf)
  }, [filled])

  const cx = size / 2
  const maxR = size / 2 - stroke / 2 - 8 // small breathing margin to the edge
  const desc = rings.map((r) => r.label).join(' · ')

  return (
    <div className="goalring" style={{ width: size, height: size }}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={`${title}: ${desc}`}
      >
        <title>{title}</title>
        <desc>{desc}</desc>
        {rings.map((ring, i) => {
          const r = maxR - i * (stroke + gap)
          const c = 2 * Math.PI * r
          const pct = clamp01(ring.pct)
          const off = filled ? Math.max(0, c * (1 - pct)) : c
          const over = ring.pct > 1.001
          return (
            <g key={i}>
              <circle className="goalring-track" cx={cx} cy={cx} r={r} strokeWidth={stroke} />
              <circle
                className="goalring-arc"
                cx={cx}
                cy={cx}
                r={r}
                strokeWidth={stroke}
                strokeLinecap="round"
                style={{
                  stroke: ring.color,
                  strokeDasharray: c.toFixed(2),
                  strokeDashoffset: off.toFixed(2),
                  filter: ring.glow
                    ? `drop-shadow(0 0 5px color-mix(in srgb, ${ring.color} 55%, transparent))`
                    : undefined,
                }}
              />
              {over && filled && (
                // overshoot: a second faint arc for the amount past 100%
                <circle
                  className="goalring-over"
                  cx={cx}
                  cy={cx}
                  r={r}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  style={{
                    stroke: ring.color,
                    strokeDasharray: c.toFixed(2),
                    strokeDashoffset: Math.max(
                      0,
                      c * (1 - clamp01(ring.pct - 1)),
                    ).toFixed(2),
                    opacity: 0.4,
                  }}
                />
              )}
            </g>
          )
        })}
      </svg>
      {children && <div className="goalring-center">{children}</div>}
    </div>
  )
}
