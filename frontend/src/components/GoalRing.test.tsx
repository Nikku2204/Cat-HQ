import { render } from '@testing-library/react'
import GoalRing from './GoalRing'

// Mount already-filled by pretending the OS asked for reduced motion — makes
// the final dashoffset deterministic (no rAF fill to await).
function reduceMotion() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('GoalRing', () => {
  it('draws one arc + track per ring and an accessible label', () => {
    reduceMotion()
    const { container } = render(
      <GoalRing
        rings={[
          { pct: 0.5, color: 'var(--accent)', label: 'Visits 4 of 8' },
          { pct: 0.75, color: 'var(--ok)', label: 'Meals 3 of 4' },
        ]}
        title="Chutku's day"
      />,
    )
    expect(container.querySelectorAll('.goalring-arc')).toHaveLength(2)
    expect(container.querySelectorAll('.goalring-track')).toHaveLength(2)
    const svg = container.querySelector('svg[role="img"]')!
    expect(svg.getAttribute('aria-label')).toContain('Visits 4 of 8')
    expect(svg.querySelector('title')?.textContent).toBe("Chutku's day")
    expect(svg.querySelector('desc')?.textContent).toContain('Meals 3 of 4')
  })

  it('fills to C·(1−pct) under reduced motion (no animation)', () => {
    reduceMotion()
    const { container } = render(
      <GoalRing rings={[{ pct: 0.5, color: 'var(--accent)', label: 'x' }]} size={128} />,
    )
    const arc = container.querySelector('.goalring-arc') as SVGCircleElement
    // size 128, stroke 8 → maxR 52, C = 2π·52 ≈ 326.73, off at 50% ≈ 163.36
    const off = Number(arc.style.strokeDashoffset)
    expect(off).toBeGreaterThan(160)
    expect(off).toBeLessThan(167)
  })

  it('renders a faint overshoot arc when pct > 1', () => {
    reduceMotion()
    const { container } = render(
      <GoalRing rings={[{ pct: 1.25, color: 'var(--ok)', label: 'x' }]} />,
    )
    expect(container.querySelector('.goalring-over')).toBeInTheDocument()
  })

  it('renders center content (the photo/mascot slot)', () => {
    reduceMotion()
    const { getByTestId } = render(
      <GoalRing rings={[{ pct: 1, color: 'var(--ok)', label: 'x' }]}>
        <span data-testid="center">🐾</span>
      </GoalRing>,
    )
    expect(getByTestId('center')).toBeInTheDocument()
  })
})
