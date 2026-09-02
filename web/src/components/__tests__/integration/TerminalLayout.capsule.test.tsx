import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TerminalLayout } from '@/components/TerminalLayout';

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

vi.mock('@/components/MobileTerminalLayout', () => ({
  MobileTerminalLayout: () => <div data-testid="mobile-terminal-layout" />,
}));

vi.mock('@/components/env/EnvPanel', () => ({ EnvPanel: () => <div data-testid="env-panel" /> }));
vi.mock('@/components/InputPanel', () => ({
  InputPanel: () => <div data-testid="input-panel" />,
}));
vi.mock('@/components/QuickCommandsPanel', () => ({
  QuickCommandsPanel: () => <div data-testid="commands-panel" />,
}));

function renderDesktopCapsule() {
  render(
    <TerminalLayout
      terminalElement={<div data-testid="terminal" />}
      sessionId="session-1"
      sendText={vi.fn()}
      onScrollPages={vi.fn()}
      onScrollToBottom={vi.fn()}
      toolbarDisabled={false}
      toolbar="capsule"
    />,
  );
}

describe('TerminalLayout desktop capsule toolbar', () => {
  it('renders TerminalCapsule instead of BottomBar Env tab when toolbar is capsule', () => {
    renderDesktopCapsule();
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-capsule')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Env/i })).not.toBeInTheDocument();
  });

  it('keeps BottomBar with Env tab when toolbar defaults to bottombar', () => {
    render(
      <TerminalLayout
        terminalElement={<div data-testid="terminal" />}
        sessionId="session-1"
        sendText={vi.fn()}
        onScrollPages={vi.fn()}
        onScrollToBottom={vi.fn()}
        toolbarDisabled={false}
      />,
    );
    expect(screen.queryByTestId('terminal-capsule')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Env/i })).toBeInTheDocument();
  });
});
