export default function Bar({
  label,
  pct,
  tone = 'ok',
  right,
}: {
  label: string
  pct: number | undefined
  tone?: 'ok' | 'warn' | 'bad'
  right?: string
}) {
  const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  return (
    <div className="bar-row">
      <div className="bar-head">
        <span>{label}</span>
        <span className="muted">{right ?? (pct == null ? '—' : `${Math.round(clamped)}%`)}</span>
      </div>
      <div className="bar-track">
        <div className={`bar-fill bar-${tone}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  )
}
