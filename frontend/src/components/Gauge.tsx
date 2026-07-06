import TickNumber from './TickNumber'

/** Radial gauge (drawer %) — SVG arc, CSS-transitioned between values. */
export default function Gauge({
  label,
  pct,
  tone = 'ok',
  size = 78,
}: {
  label: string
  pct: number | undefined
  tone?: 'ok' | 'warn' | 'bad'
  size?: number
}) {
  const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const stroke = 7
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <div className="gauge">
      <div className="gauge-dial" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle
            className="ring-track"
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
          />
          <circle
            className={`gauge-arc tone-${tone}`}
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={`${(clamped / 100) * c} ${c}`}
            strokeLinecap="round"
          />
        </svg>
        <span className="gauge-val">
          {pct == null ? '—' : <TickNumber value={clamped} suffix="%" />}
        </span>
      </div>
      <span className="viz-label">{label}</span>
    </div>
  )
}
