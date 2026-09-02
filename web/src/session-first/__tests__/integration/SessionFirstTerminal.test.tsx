import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { SessionFirstTerminal } from '@/session-first/SessionFirstTerminal';
import { sessionIdAtom, attachInfoAtom } from '@/atoms/session';
import { bannerAtomFamily } from '@/terminal/state/ui';

const { wsListeners } = vi.hoisted(() => ({
  wsListeners: [] as Array<(status: string) => void>,
}));

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
    onConnectionChange: (cb: (status: string) => void) => {
      wsListeners.push(cb);
      return () => {
        const i = wsListeners.indexOf(cb);
        if (i >= 0) {
          wsListeners.splice(i, 1);
        }
      };
    },
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
vi.mock('@/components/TerminalLayout', () => ({
  TerminalLayout: ({
    terminalElement,
    terminalOnly,
    toolbar,
  }: {
    terminalElement: React.ReactNode;
    terminalOnly?: boolean;
    toolbar?: string;
  }) => (
    <div
      data-testid="terminal-layout"
      data-terminal-only={terminalOnly ? 'true' : 'false'}
      data-toolbar={toolbar ?? 'bottombar'}
    >
      {terminalElement}
    </div>
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
  beforeEach(() => {
    wsListeners.length = 0;
  });

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

  it('renders TerminalLayout with capsule toolbar when a session is attached', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    renderTerminal(false, store);
    const layout = screen.getByTestId('terminal-layout');
    expect(layout).toBeInTheDocument();
    expect(layout).toHaveAttribute('data-toolbar', 'capsule');
    expect(layout).toHaveAttribute('data-terminal-only', 'true');
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

  it('clears a stuck failed banner when attaching a new session after relay drop', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:old');
    renderTerminal(false, store);

    act(() => {
      for (const cb of wsListeners) {
        cb('disconnected');
      }
    });
    expect(store.get(bannerAtomFamily('agent:old'))).toBe('failed');

    act(() => {
      store.set(sessionIdAtom, 'agent:new');
    });
    expect(store.get(bannerAtomFamily('agent:new'))).toBe('none');
  });

  it('clears a stuck failed banner when switching the same session to P2P', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    renderTerminal(false, store);

    act(() => {
      for (const cb of wsListeners) {
        cb('disconnected');
      }
    });
    expect(store.get(bannerAtomFamily('agent:sess'))).toBe('failed');

    act(() => {
      store.set(attachInfoAtom, { mode: 'p2p', session_id: 'agent:sess' });
    });
    expect(store.get(bannerAtomFamily('agent:sess'))).toBe('none');
  });
});
