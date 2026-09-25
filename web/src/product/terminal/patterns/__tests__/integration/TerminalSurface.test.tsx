import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalSurface } from '@/product/terminal/patterns/TerminalSurface';

/**
 * Answers "yes, desktop" — deliberately, and it is load-bearing.
 *
 * `TerminalSurface` must not consult the viewport at all any more, so any
 * media query reintroduced here would be answered `true` and would show up as
 * the *wrong capsule* rather than as a silent 768-vs-1024 disagreement.
 */
vi.mock('@/shared/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
}));

vi.mock('@/product/terminal/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

function renderSurface(experience: 'web' | 'app') {
  return render(
    <TerminalSurface
      experience={experience}
      inputDisabled={false}
      controller={null}
    >
      <div data-testid="terminal-viewport-slot" />
    </TerminalSurface>,
  );
}

describe('TerminalSurface', () => {
  it('hosts xterm tree and floating capsule without legacy layout', () => {
    renderSurface('web');

    expect(screen.getByTestId('terminal-surface')).toHaveAttribute(
      'data-terminal-capsule-host',
    );
    expect(screen.getByTestId('terminal-surface')).toHaveAttribute(
      'data-terminal-scrollback-mode',
      'local-buffer',
    );
    expect(screen.getByTestId('terminal-viewport-slot')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-terminal-layout')).not.toBeInTheDocument();
  });

  it('takes the capsule experience from the shell, not from the viewport', () => {
    // Regression (#1049 / #1057). This component used to choose the capsule
    // with its own `useMediaQuery('(min-width: 768px)')` while the shell chose
    // its layout with `(min-width: 1024px)`. Between those widths the App shell
    // drew an App layout around a **Web** capsule — including the permanent
    // history control #1034 retired. iPad portrait and every landscape phone
    // live in that band.
    //
    // The mocked query above returns `true`, so this passes only while the prop
    // is what decides: if a viewport query ever comes back, the `app` render
    // below would produce the web capsule and fail here.
    const app = renderSurface('app');
    expect(screen.queryByTestId('capsule-history-trigger')).toBeNull();
    app.unmount();

    renderSurface('web');
    expect(screen.getByTestId('capsule-history-trigger')).toBeInTheDocument();
  });
});
