import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileTerminalLayout } from '../MobileTerminalLayout';

// Heavy children are coverage-excluded components with WebSocket/DOM deps —
// stub them so this test stays focused on the layout wiring.
vi.mock('../env/EnvPanel', () => ({ EnvPanel: () => <div data-testid="env-panel" /> }));
vi.mock('../FileBrowser', () => ({ FileBrowser: () => <div data-testid="file-browser" /> }));
vi.mock('../FileViewer', () => ({ FileViewer: () => <div data-testid="file-viewer" /> }));

function setup() {
  const onScrollPages = vi.fn();
  const onScrollToBottom = vi.fn();
  render(
    <MobileTerminalLayout
      terminalElement={<div data-testid="terminal" />}
      sessionId="session-1"
      sendText={vi.fn()}
      toolbarDisabled={false}
      onScrollPages={onScrollPages}
      onScrollToBottom={onScrollToBottom}
    />,
  );
  return { onScrollPages, onScrollToBottom };
}

describe('MobileTerminalLayout', () => {
  it('renders the scroll overlay over the terminal panel', () => {
    setup();
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll up one page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll down one page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument();
  });

  it('overlay taps invoke the scroll callbacks', () => {
    const { onScrollPages, onScrollToBottom } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll up one page' }));
    expect(onScrollPages).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);
  });
});
