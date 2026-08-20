import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileTerminalLayout } from '@/components/MobileTerminalLayout';

// Heavy children are coverage-excluded components with WebSocket/DOM deps —
// stub them so this test stays focused on the layout wiring.
vi.mock( '@/components/env/EnvPanel', () => ({ EnvPanel: () => <div data-testid="env-panel" /> }));
vi.mock( '@/components/FileBrowser', () => ({ FileBrowser: () => <div data-testid="file-browser" /> }));
vi.mock( '@/components/FileViewer', () => ({ FileViewer: () => <div data-testid="file-viewer" /> }));

function setup(terminalElement: React.ReactNode = <div data-testid="terminal" />) {
  const onScrollPages = vi.fn();
  const onScrollToBottom = vi.fn();
  render(
    <MobileTerminalLayout
      terminalElement={terminalElement}
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

  it('does not render the overlay when terminalElement is null (desktop path)', () => {
    setup(null);
    expect(screen.queryByRole('button', { name: 'Scroll up one page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll down one page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument();
  });
});
