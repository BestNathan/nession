import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionFirstTerminalPane } from '@/session-first/terminal/SessionFirstTerminalPane';
import type { TerminalController } from '@/terminal/controller/TerminalController';

vi.mock('@/terminal/components/TerminalViewport', () => ({
  TerminalViewport: () => <div data-testid="terminal-viewport" />,
}));

vi.mock('@/terminal/components/input/TerminalInputOverlay', () => ({
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
        transportKey="0:"
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
        transportKey="0:wss://agent"
      />,
    );

    expect(screen.getByTestId('terminal-viewport')).toBeInTheDocument();
    expect(screen.queryByTestId('session-first-terminal-loading')).not.toBeInTheDocument();
  });
});
