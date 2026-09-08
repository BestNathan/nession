import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileTerminalLayout } from '@/components/MobileTerminalLayout';
import type { TerminalController } from '@/core/terminal-runtime/controller/TerminalController';

// Heavy children are coverage-excluded components with WebSocket/DOM deps —
// stub them so this test stays focused on the layout wiring.
vi.mock( '@/components/env/EnvPanel', () => ({ EnvPanel: () => <div data-testid="env-panel" /> }));
vi.mock( '@/components/FileBrowser', () => ({ FileBrowser: () => <div data-testid="file-browser" /> }));
vi.mock( '@/components/FileViewer', () => ({ FileViewer: () => <div data-testid="file-viewer" /> }));

function setup(
  terminalElement: React.ReactNode = <div data-testid="terminal" />,
  options: {
    toolbarDisabled?: boolean;
    controller?: Pick<TerminalController, 'handleInput'> | null;
    terminalOnly?: boolean;
  } = {},
) {
  const { toolbarDisabled = false, controller = null, terminalOnly = false } = options;
  render(
    <MobileTerminalLayout
      terminalElement={terminalElement}
      sessionId="session-1"
      sendText={vi.fn()}
      toolbarDisabled={toolbarDisabled}
      controller={controller as TerminalController | null | undefined}
      terminalOnly={terminalOnly}
    />,
  );
}

describe('MobileTerminalLayout', () => {
  it('renders the terminal panel without scroll overlay chrome', () => {
    setup();
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll up one page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll down one page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument();
  });

  it('does not render scroll overlay when terminalElement is null (desktop path)', () => {
    setup(null);
    expect(screen.queryByRole('button', { name: 'Scroll up one page' })).not.toBeInTheDocument();
  });
});

describe('MobileTerminalLayout collapsed toolbar shortcut buttons', () => {
  it('renders Tab and Esc buttons alongside the original five', () => {
    setup();
    // Original five
    expect(screen.getByRole('button', { name: 'Ctrl-C' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Space' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ctrl-R' })).toBeInTheDocument();
    // New two
    expect(screen.getByRole('button', { name: 'Tab' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Esc' })).toBeInTheDocument();
  });

  it('Tab button sends \\t via controller.handleInput', () => {
    const handleInput = vi.fn();
    setup(<div data-testid="terminal" />, { controller: { handleInput } });
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(handleInput).toHaveBeenCalledWith(
      expect.objectContaining({ data: '\t' }),
    );
  });

  it('Esc button sends \\x1b via controller.handleInput', () => {
    const handleInput = vi.fn();
    setup(<div data-testid="terminal" />, { controller: { handleInput } });
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(handleInput).toHaveBeenCalledWith(
      expect.objectContaining({ data: '\x1b' }),
    );
  });

  it('all shortcut buttons are disabled when toolbarDisabled=true', () => {
    setup(<div data-testid="terminal" />, { toolbarDisabled: true });
    for (const label of ['Ctrl-C', 'Space', 'Enter', 'Clear', 'Ctrl-R', 'Tab', 'Esc']) {
      const btn = screen.getByRole('button', { name: label });
      expect(btn).toBeDisabled();
    }
  });

  it('shortcut row is a horizontally scrollable container', () => {
    setup();
    const tabButton = screen.getByRole('button', { name: 'Tab' });
    const row = tabButton.parentElement;
    expect(row).not.toBeNull();
    // jsdom does not compute Tailwind, so assert the class is present.
    expect(row?.className).toMatch(/overflow-x-auto/);
  });
});

describe('MobileTerminalLayout terminalOnly', () => {
  it('skips swipe ModeBar and Files/Env panels', () => {
    setup(<div data-testid="terminal" />, { terminalOnly: true });
    expect(screen.getByTestId('mobile-terminal-only')).toBeInTheDocument();
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.queryByText('Files')).not.toBeInTheDocument();
    expect(screen.queryByText('Environment')).not.toBeInTheDocument();
  });

  it('uses TerminalCapsule instead of the bottom Input|Commands toolbar', () => {
    setup(<div data-testid="terminal" />, { terminalOnly: true });
    expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open input panel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Env/i })).not.toBeInTheDocument();
  });
});
