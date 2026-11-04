import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from '@/product/terminal/TerminalPane';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';

const { viewportProps } = vi.hoisted(() => ({ viewportProps: vi.fn() }));

vi.mock('@/product/terminal/components/TerminalViewport', () => ({
  TerminalViewport: (props: Record<string, unknown>) => {
    viewportProps(props);
    return <div data-testid="terminal-viewport" />;
  },
}));

vi.mock('@/product/terminal/components/input/TerminalInputOverlay', () => ({
  TerminalInputOverlay: () => null,
}));

function makeController(): TerminalController {
  return {} as TerminalController;
}

describe('TerminalPane', () => {
  beforeEach(() => {
    viewportProps.mockClear();
  });

  it('does not mount xterm before the transport viewport is ready', () => {
    render(
      <TerminalPane
        sessionId="agent:sess"
        controller={makeController()}
        terminalState="connecting"
        viewportReady={false}
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
      />,
    );

    expect(screen.getByTestId('terminal-viewport')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-loading')).not.toBeInTheDocument();
  });

  it('forwards the input gate and the shell edge reservation to the viewport', () => {
    const touchEdgeReservation = () => true;
    render(
      <TerminalPane
        sessionId="agent:sess"
        controller={makeController()}
        terminalState="attached"
        viewportReady
        inputDisabled
        touchEdgeReservation={touchEdgeReservation}
      />,
    );

    expect(viewportProps).toHaveBeenLastCalledWith(expect.objectContaining({
      inputDisabled: true,
      touchEdgeReservation,
    }));
  });
});
