import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TerminalWell } from './TerminalWell'

describe('TerminalWell', () => {
  it('renders children inside the well container', () => {
    render(
      <TerminalWell>
        <div data-testid="child">terminal</div>
      </TerminalWell>,
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.getByTestId('terminal-well')).toBeInTheDocument()
  })

  it('applies well class for dark rounded container', () => {
    const { container } = render(<TerminalWell><span /></TerminalWell>)
    const well = container.querySelector('[data-testid="terminal-well"]')
    expect(well?.className).toMatch(/terminal-well/)
  })
})
