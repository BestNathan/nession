import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';

describe('composer token wiring', () => {
  it('binds web field font-size class to --terminal-capsule-font-size', () => {
    render(<TerminalCapsule experience="web" sendText={() => {}} />);
    const input = screen.getByTestId('capsule-ghost-input');
    expect(input.className).toMatch(/terminal-capsule-font-size/);
    expect(input.className).toMatch(/terminal-capsule-text-line-height/);
    expect(input.className).not.toMatch(/text-\[length:var\(--terminal-capsule-line-height\)\]/);
  });

  it('remaps app experience on shell and keeps the resting row single-line', () => {
    render(<TerminalCapsule experience="app" sendText={() => {}} />);
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-experience', 'app');
    const row = screen.getByTestId('capsule-input-row');
    expect(row).toHaveAttribute('data-layout', 'flat');
    expect(row).not.toHaveAttribute('data-field-first');
    expect(row.className).toMatch(/grid-cols-\[auto_minmax/);
    expect(screen.queryByTestId('capsule-input-toolbar-row')).not.toBeInTheDocument();
    expect(screen.getByTestId('capsule-input-field')).toHaveAttribute('data-input-width', 'column');
  });

  it('restores pointer events on the app shell so the composer is tappable', () => {
    render(<TerminalCapsule experience="app" sendText={() => {}} />);
    // Host is pointer-transparent so touches scroll past the capsule;
    // the inner shell must re-enable pointer events or every tap (input,
    // capability entry, send) falls through to the terminal underneath.
    expect(screen.getByTestId('terminal-capsule').className).toMatch(/pointer-events-none/);
    expect(screen.getByTestId('capsule-shell').className).toMatch(/pointer-events-auto/);
  });
});
