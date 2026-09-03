import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalCapsule } from '@/session-first/capsule/TerminalCapsule';

describe('composer token wiring', () => {
  it('binds web field font-size class to --composer-font-size', () => {
    render(<TerminalCapsule experience="web" sendText={() => {}} />);
    const input = screen.getByTestId('capsule-ghost-input');
    expect(input.className).toMatch(/composer-font-size/);
    expect(input.className).toMatch(/composer-text-line-height/);
    expect(input.className).not.toMatch(/text-\[length:var\(--composer-line-height\)\]/);
  });

  it('remaps app experience on shell and keeps full-width flat field', () => {
    render(
      <TerminalCapsule experience="app" mode="input" onModeChange={() => {}} sendText={() => {}} />,
    );
    expect(screen.getByTestId('terminal-capsule')).toHaveAttribute('data-experience', 'app');
    expect(screen.getByTestId('capsule-input-row')).toHaveAttribute('data-field-first', 'app');
    expect(screen.getByTestId('capsule-input-field')).toHaveAttribute('data-input-width', 'full');
  });

  it('restores pointer events on the app shell so the composer is tappable', () => {
    render(
      <TerminalCapsule experience="app" mode="input" onModeChange={() => {}} sendText={() => {}} />,
    );
    // Host is pointer-transparent so touches scroll past the capsule;
    // the inner shell must re-enable pointer events or every tap (input,
    // mode toggle, send) falls through to the terminal underneath.
    expect(screen.getByTestId('terminal-capsule').className).toMatch(/pointer-events-none/);
    expect(screen.getByTestId('capsule-shell').className).toMatch(/pointer-events-auto/);
  });
});
