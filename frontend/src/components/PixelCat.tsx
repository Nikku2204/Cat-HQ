import type { Mood } from '../insights'

/** Hand-rolled pixel cat (12×10 grid) — the "midnight den" mascot.
 * Pure SVG rects, zero deps; colors ride on currentColor + CSS vars.
 *
 * The Den (M5.7) adds a `mood` prop that swaps the rect grid (docs/06 delight
 * mechanics). No-arg usage is unchanged — the App header still gets the awake
 * pose. Any idle motion is gated behind prefers-reduced-motion in styles.css.
 */

// 1 = fur, 2 = ear-inner/nose/closed-eye accent, 3 = open eye
const AWAKE = [
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

// eyes shut to soft accent slits, a calm sleeping curl
const SLEEPY = [
  '1..........1',
  '11........11',
  '111......111',
  '111111111111',
  '111111111111',
  '121111111211',
  '111111111111',
  '112111111211',
  '111122221111',
  '.1111111111.',
]

// ears pricked, eyes wide — just heard the box / a "Cat Detected"
const ALERT = [
  '1..........1',
  '11........11',
  '121......121',
  '131111111311',
  '111111111111',
  '131111111311',
  '111111111111',
  '112111111211',
  '111122221111',
  '.1111111111.',
]

const GRID: Record<'awake' | 'sleepy' | 'alert', string[]> = {
  awake: AWAKE,
  sleepy: SLEEPY,
  alert: ALERT,
}

function poseFor(mood: Mood | undefined): 'awake' | 'sleepy' | 'alert' {
  if (mood === 'sleepy') return 'sleepy'
  if (mood === 'justVisited' || mood === 'restless') return 'alert'
  return 'awake'
}

export default function PixelCat({
  size = 22,
  mood,
}: {
  size?: number
  mood?: Mood
}) {
  const pose = poseFor(mood)
  const grid = GRID[pose]
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
      className={`pixel-cat pose-${pose}`}
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
