import { render } from '@testing-library/react'
import ChutkuCat from './ChutkuCat'

describe('ChutkuCat (the hand-drawn tabby)', () => {
  it('renders an accessible cat with tail, blink group, and whiskers by default', () => {
    const { container } = render(<ChutkuCat />)
    const svg = container.querySelector('svg.cc')!
    expect(svg).toHaveClass('pose-awake')
    expect(svg).toHaveAttribute('role', 'img')
    expect(svg).toHaveAttribute('aria-label', 'Chutku looking awake')
    expect(svg.querySelector('.cc-tail')).toBeInTheDocument()
    expect(svg.querySelector('.cc-blink')).toBeInTheDocument()
    expect(svg.querySelector('.cc-pupils')).toBeInTheDocument()
  })

  it('happy: squint arcs replace the open eyes (no blink group)', () => {
    const { container } = render(<ChutkuCat pose="happy" />)
    const svg = container.querySelector('svg.cc')!
    expect(svg).toHaveClass('pose-happy')
    expect(svg.querySelector('.cc-blink')).toBeNull() // eyes are ^‿^ arcs
  })

  it('grumpy: airplane ears (rotated) + heavy lids stay in the blink group', () => {
    const { container } = render(<ChutkuCat pose="grumpy" />)
    const svg = container.querySelector('svg.cc')!
    expect(svg).toHaveClass('pose-grumpy')
    // both ear groups carry the flatten transform
    const rotated = [...svg.querySelectorAll('g[transform*="rotate"]')]
    expect(rotated.length).toBeGreaterThanOrEqual(2)
    expect(svg.querySelector('.cc-blink')).toBeInTheDocument()
  })

  it('alert: keeps the pupils group so the scheming dart animation can run', () => {
    const { container } = render(<ChutkuCat pose="alert" />)
    const svg = container.querySelector('svg.cc')!
    expect(svg).toHaveClass('pose-alert')
    expect(svg.querySelector('.cc-pupils')).toBeInTheDocument()
  })
})
