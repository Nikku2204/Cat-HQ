import { render } from '@testing-library/react'
import Sparkline from './Sparkline'

describe('Sparkline', () => {
  it('renders nothing with fewer than two points', () => {
    const { container } = render(<Sparkline values={[13.1]} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('base form: polyline + last-point dot, decorative (aria-hidden)', () => {
    const { container } = render(<Sparkline values={[13.0, 13.2, 13.1]} />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg.querySelector('polyline')).toBeInTheDocument()
    expect(svg.querySelectorAll('circle')).toHaveLength(1) // last-point only
  })

  it('draws the normal band, median line, and min/max markers when asked', () => {
    const { container } = render(
      <Sparkline
        values={[13.0, 12.4, 13.3, 13.1]}
        medianValues={[13.0, 12.7, 13.0, 13.1]}
        band={{ low: 12.5, high: 14 }}
        markers
      />,
    )
    expect(container.querySelector('.den-band')).toBeInTheDocument()
    expect(container.querySelector('.den-wmed')).toBeInTheDocument()
    // min + max markers + the last-point dot = 3 circles
    expect(container.querySelectorAll('circle')).toHaveLength(3)
    expect(container.querySelector('.den-mark-hi')).toBeInTheDocument()
    expect(container.querySelector('.den-mark-lo')).toBeInTheDocument()
  })

  it('is a labelled image when given a title/desc', () => {
    const { container } = render(
      <Sparkline values={[13, 13.2]} title="Weight over 30 days" desc="Currently 13.2 lb" />,
    )
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('role', 'img')
    expect(svg).not.toHaveAttribute('aria-hidden')
    expect(svg.querySelector('title')?.textContent).toBe('Weight over 30 days')
    expect(svg.querySelector('desc')?.textContent).toBe('Currently 13.2 lb')
  })

  it('the band rect never has negative height', () => {
    // band wider than the data domain must not invert.
    const { container } = render(
      <Sparkline values={[13, 13.1]} band={{ low: 12.5, high: 14 }} />,
    )
    const rect = container.querySelector('.den-band') as SVGRectElement
    expect(Number(rect.getAttribute('height'))).toBeGreaterThanOrEqual(0)
  })
})
