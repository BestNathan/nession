import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionFirstTerminalPane } from '@/features/terminal/SessionFirstTerminalPane';
import type { TerminalController } from '@/core/terminal-runtime/controller/TerminalController';

vi.mock('@/features/terminal/components/TerminalViewport', () => ({
  TerminalViewport: () => <div data-testid="terminal-viewport" />,
}));

vi.mock('@/features/terminal/components/input/TerminalInputOverlay', () => ({
  TerminalInputOverlay: () => null,
}));

function makeController(): TerminalController {
  return {} as TerminalController;
}

describe('SessionFirstTerminalPane', () => {
  it('does not mount xterm before the transport viewport is ready', () => {
    render(
      <SessionFirstTerminalPane
        sessionId="agent:sess"
        controller={makeController()}
        terminalState="connecting"
        viewportReady={false}
        transportEpoch={0}
      />,
    );

    expect(screen.queryByTestId('terminal-viewport')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-first-terminal-loading')).toBeInTheDocument();
  });

  it('mounts xterm once the transport viewport is ready', () => {
    render(
      <SessionFirstTerminalPane
        sessionId="agent:sess"
        controller={makeController()}
        terminalState="attached"
        viewportReady
        transportEpoch={0}
      />,
    );

    expect(screen.getByTestId('terminal-viewport')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-terminal-loading')).not.toBeInTheDocument();
  });
});
