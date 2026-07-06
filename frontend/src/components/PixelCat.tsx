/** Hand-rolled pixel cat (12×10 grid) — the "midnight den" mascot.
 * Pure SVG rects, zero deps; colors ride on currentColor + CSS vars. */
export default function PixelCat({ size = 22 }: { size?: number }) {
  // 1 = fur, 2 = ear-inner/nose accent, 3 = eyes
  const grid = [
    '1..........1',
    '11........11',
    '121......121',
    '111111111111',
    '111111111111',
    '131111111311',
    '111111111111',
    '112111111211',
    '111122221111',
    '.1111111111.',
  ]
  const cells: { x: number; y: number; k: string }[] = []
  grid.forEach((row, y) => {
    row.split('').forEach((c, x) => {
      if (c !== '.') cells.push({ x, y, k: c })
    })
  })
  const fill = (k: string) =>
    k === '3' ? 'var(--bg)' : k === '2' ? 'var(--accent)' : 'currentColor'
  return (
    <svg
      className="pixel-cat"
      width={size}
      height={(size * 10) / 12}
      viewBox="0 0 12 10"
      aria-hidden="true"
    >
      {cells.map(({ x, y, k }, i) => (
        <rect key={i} x={x} y={y} width="1" height="1" fill={fill(k)} />
      ))}
    </svg>
  )
}
