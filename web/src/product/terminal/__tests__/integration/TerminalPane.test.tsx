import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalPane } from '@/product/terminal/TerminalPane';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';

vi.mock('@/product/terminal/components/TerminalViewport', () => ({
  TerminalViewport: () => <div data-testid="terminal-viewport" />,
}));

vi.mock('@/product/terminal/components/input/TerminalInputOverlay', () => ({
  TerminalInputOverlay: () => null,
}));

function makeController(): TerminalController {
  return {} as TerminalController;
}

describe('TerminalPane', () => {
  it('does not mount xterm before the transport viewport is ready', () => {
    render(
      <TerminalPane
        sessionId="agent:sess"
        controller={makeController()}
        terminalState="connecting"
        viewportReady={false}
        transportEpoch={0}
      />,
    );

    expect(screen.queryByTestId('terminal-viewport')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-loading')).toBeInTheDocument();
  });

  it('mounts xterm once the transport viewport is ready', () => {
    render(
      <TerminalPane
        sessionId="agent:sess"
        controller={makeController()}
        terminalState="attached"
        viewportReady
        transportEpoch={0}
      />,
    );

    expect(screen.getByTestId('terminal-viewport')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-loading')).not.toBeInTheDocument();
  });
});
