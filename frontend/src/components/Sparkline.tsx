/**
 * Hand-rolled SVG sparkline. Values are chronological.
 *
 * The base (values-only) form is unchanged — LitterCard's weight mini still
 * works. The Den (M5.7) extends it, additively, with an optional shaded normal
 * band, a faint rolling-median line, and min/max markers (docs/06 T3). ONE
 * shared component across every trend, to protect the bundle.
 *
 * Retina (T3): the whole chart uses a fixed coordinate viewBox and scales
 * UNIFORMLY (width:100%, height:auto via the `.den-chart` class) so dot markers
 * stay round under stretch — no preserveAspectRatio="none" when markers exist.
 */
export default function Sparkline({
  values,
  width = 120,
  height = 30,
  pad = 4,
  band,
  medianValues,
  markers = false,
  className = '',
  title,
  desc,
}: {
  values: number[]
  width?: number
  height?: number
  pad?: number
  /** shaded "normal" band in value units */
  band?: { low: number; high: number }
  /** faint smoothing line, aligned to `values` */
  medianValues?: number[]
  /** draw min/max dots in addition to the last-point dot */
  markers?: boolean
  className?: string
  /** when given, the chart is a labelled image; else it's decorative */
  title?: string
  desc?: string
}) {
  if (values.length < 2) return null

  // Domain spans everything we draw so nothing clips.
  const domain = [
    ...values,
    ...(medianValues ?? []),
    ...(band ? [band.low, band.high] : []),
  ].filter((v) => Number.isFinite(v))
  const min = Math.min(...domain)
  const max = Math.max(...domain)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2)
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2)

  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const medPts =
    medianValues && medianValues.length === values.length
      ? medianValues.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
      : null

  const lastIdx = values.length - 1
  let minIdx = 0
  let maxIdx = 0
  values.forEach((v, i) => {
    if (v < values[minIdx]) minIdx = i
    if (v > values[maxIdx]) maxIdx = i
  })

  const labelled = Boolean(title || desc)

  return (
    <svg
      className={`spark ${className}`.trim()}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : 'true'}
      aria-label={labelled ? title : undefined}
    >
      {labelled && title && <title>{title}</title>}
      {labelled && desc && <desc>{desc}</desc>}
      {band && (
        <rect
          className="den-band"
          x="0"
          width={width}
          y={y(band.high).toFixed(1)}
          height={Math.max(0, y(band.low) - y(band.high)).toFixed(1)}
        />
      )}
      {medPts && <polyline className="den-wmed" points={medPts} />}
      <polyline points={pts} />
      {markers && (
        <>
          <circle className="den-mark den-mark-hi" cx={x(maxIdx)} cy={y(values[maxIdx])} r="2.2" />
          <circle className="den-mark den-mark-lo" cx={x(minIdx)} cy={y(values[minIdx])} r="2.2" />
        </>
      )}
      <circle cx={x(lastIdx)} cy={y(values[lastIdx])} r="2.6" />
    </svg>
  )
}
