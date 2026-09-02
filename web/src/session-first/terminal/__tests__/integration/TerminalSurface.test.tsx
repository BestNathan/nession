import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalSurface } from '@/session-first/terminal/TerminalSurface';

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
}));

vi.mock('@/hooks/useQuickCommands', () => ({
  useQuickCommands: () => ({
    userCommands: [],
    addCommand: vi.fn().mockResolvedValue(undefined),
    deleteCommand: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

describe('TerminalSurface', () => {
  it('hosts xterm tree and floating capsule without legacy layout', () => {
    render(
      <TerminalSurface
        inputDisabled={false}
        controller={null}
        onScrollPages={vi.fn()}
        onScrollToBottom={vi.fn()}
      >
        <div data-testid="terminal-viewport-slot" />
      </TerminalSurface>,
    );

    expect(screen.getByTestId('session-first-terminal-surface')).toHaveAttribute(
      'data-terminal-capsule-host',
    );
    expect(screen.getByTestId('session-first-terminal-surface')).toHaveAttribute(
      'data-terminal-scrollback-mode',
      'local-buffer',
    );
    expect(screen.getByTestId('terminal-viewport-slot')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-terminal-layout')).not.toBeInTheDocument();
  });
});
