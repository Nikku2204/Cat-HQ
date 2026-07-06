/** Vertical fill tube (litter level) — plain divs, height-transitioned. */
export default function Tube({
  label,
  pct,
  tone = 'ok',
}: {
  label: string
  pct: number | undefined
  tone?: 'ok' | 'warn' | 'bad'
}) {
  const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  return (
    <div className="tube">
      <div className="tube-body" role="img" aria-label={`${label} ${pct == null ? 'unknown' : `${Math.round(clamped)}%`}`}>
        <div className={`tube-fill tone-${tone}`} style={{ height: `${clamped}%` }} />
      </div>
      <span className="tube-val">{pct == null ? '—' : `${Math.round(clamped)}%`}</span>
      <span className="viz-label">{label}</span>
    </div>
  )
}
