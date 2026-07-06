/** Hand-rolled SVG sparkline (weight trend). Values are chronological. */
export default function Sparkline({
  values,
  width = 120,
  height = 30,
}: {
  values: number[]
  width?: number
  height?: number
}) {
  if (values.length < 2) return null
  const pad = 4
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2)
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2)
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const last = values[values.length - 1]
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline points={pts} />
      <circle cx={x(values.length - 1)} cy={y(last)} r="2.6" />
    </svg>
  )
}
