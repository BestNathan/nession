import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { SessionFirstTerminal } from '@/session-first/SessionFirstTerminal';
import { sessionIdAtom } from '@/atoms/session';

vi.mock('@/hooks/useP2PConnection', () => ({ useP2PConnection: () => {} }));
vi.mock('@/hooks/useAddressPlan', () => ({
  useAddressPlan: () => ({ ready: true, urls: [] }),
}));
vi.mock('@/terminal/hooks/useTerminalStateMachine', () => ({
  useTerminalStateMachine: () => ({ terminalState: 'idle', reconnectCount: 0 }),
}));
vi.mock('@/terminal/hooks/useTerminal', () => ({ useTerminal: () => null }));
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    onConnectionChange: () => () => {},
    isConnected: () => false,
    endRelay: vi.fn(),
    applySessionEnv: vi.fn(),
  }),
}));
vi.mock('@/terminal/components/TerminalPane', () => ({
  TerminalPane: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-pane">{sessionId}</div>
  ),
}));

function renderTerminal(hidden: boolean, store = createStore()) {
  const onDisconnect = vi.fn();
  const onError = vi.fn();
  const view = (
    <Provider store={store}>
      <SessionFirstTerminal hidden={hidden} onDisconnect={onDisconnect} onError={onError} />
    </Provider>
  );
  const result = render(view);
  return {
    ...result,
    store,
    rerenderHidden: (next: boolean) =>
      result.rerender(
        <Provider store={store}>
          <SessionFirstTerminal hidden={next} onDisconnect={onDisconnect} onError={onError} />
        </Provider>,
      ),
  };
}

describe('SessionFirstTerminal', () => {
  it('toggles CSS hidden without unmounting the keep-alive root', () => {
    const { rerenderHidden } = renderTerminal(false);
    const el = screen.getByTestId('session-first-terminal');
    expect(el.className).not.toMatch(/\bhidden\b/);

    rerenderHidden(true);
    const still = screen.getByTestId('session-first-terminal');
    expect(still).toBe(el);
    expect(still.className).toMatch(/\bhidden\b/);
  });

  it('shows a muted empty state when no session is selected', () => {
    renderTerminal(false);
    const root = screen.getByTestId('session-first-terminal');
    expect(root).toHaveTextContent('Select a session');
    expect(screen.queryByTestId('terminal-pane')).not.toBeInTheDocument();
  });

  it('keeps TerminalPane mounted when hidden while a session is attached', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    const { rerenderHidden } = renderTerminal(false, store);

    const pane = screen.getByTestId('terminal-pane');
    expect(pane).toHaveTextContent('agent:sess');

    rerenderHidden(true);
    expect(screen.getByTestId('session-first-terminal').className).toMatch(/\bhidden\b/);
    expect(screen.getByTestId('terminal-pane')).toBe(pane);
  });
});
