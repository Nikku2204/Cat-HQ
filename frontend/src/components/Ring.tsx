import type { ReactNode } from 'react'

export type RingMode = 'ok' | 'busy' | 'bad' | 'off'

/** Status ring (docs/05 Part B item 1): green steady when ready, amber
 * indeterminate sweep while cycling, red on faults, grey when offline.
 * The sweep is CSS-animated; prefers-reduced-motion freezes it to a
 * static arc (styles.css). */
export default function Ring({
  mode,
  size = 112,
  children,
}: {
  mode: RingMode
  size?: number
  children?: ReactNode
}) {
  const stroke = 6
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  // busy: a 28% arc that spins; other modes: full circle
  const dash = mode === 'busy' ? `${c * 0.28} ${c}` : `${c} 0`
  return (
    <div
      className={`ring ring-${mode}`}
      style={{ width: size, height: size }}
      data-mode={mode}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="ring-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
        />
        <circle
          className="ring-arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
      </svg>
      <div className="ring-inner">{children}</div>
    </div>
  )
}
