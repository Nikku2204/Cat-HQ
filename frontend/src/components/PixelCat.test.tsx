import { render } from '@testing-library/react'
import PixelCat from './PixelCat'

describe('PixelCat', () => {
  it('defaults to the awake pose (unchanged App-header behavior)', () => {
    const { container } = render(<PixelCat />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveClass('pixel-cat', 'pose-awake')
    expect(svg.querySelectorAll('rect').length).toBeGreaterThan(0)
  })

  it('sleepy mood → the sleeping pose', () => {
    const { container } = render(<PixelCat mood="sleepy" />)
    expect(container.querySelector('svg')).toHaveClass('pose-sleepy')
  })

  it('just-visited and restless share the alert pose', () => {
    const { container: a } = render(<PixelCat mood="justVisited" />)
    expect(a.querySelector('svg')).toHaveClass('pose-alert')
    const { container: b } = render(<PixelCat mood="restless" />)
    expect(b.querySelector('svg')).toHaveClass('pose-alert')
  })

  it('content/quiet/neutral fall back to awake', () => {
    for (const m of ['content', 'quiet', 'neutral'] as const) {
      const { container } = render(<PixelCat mood={m} />)
      expect(container.querySelector('svg')).toHaveClass('pose-awake')
    }
  })
})
