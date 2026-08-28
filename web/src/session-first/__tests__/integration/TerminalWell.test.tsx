import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalWell } from '@/session-first/TerminalWell';

describe('TerminalWell', () => {
  it('wraps children in a dark rounded well', () => {
    render(
      <TerminalWell>
        <div data-testid="child">term</div>
      </TerminalWell>,
    );
    const well = screen.getByTestId('terminal-well');
    expect(well).toContainElement(screen.getByTestId('child'));
    expect(well.className).toMatch(/rounded/);
    expect(well.className).toMatch(/overflow-hidden/);
    expect(well.className).toMatch(/\brelative\b/);
  });
});
