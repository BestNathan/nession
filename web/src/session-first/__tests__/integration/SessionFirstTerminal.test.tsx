import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { SessionFirstTerminal } from '@/session-first/SessionFirstTerminal';
import { sessionIdAtom, attachInfoAtom } from '@/atoms/session';
import { bannerAtomFamily } from '@/terminal/state/ui';
import type { ConnectionState } from '@/services/socket/types';

const { wsListeners } = vi.hoisted(() => ({
  wsListeners: [] as Array<(state: ConnectionState) => void>,
}));

vi.mock('@/hooks/useP2PAttachTransport', () => ({
  useP2PAttachTransport: () => ({
    waitingForAddressPlan: false,
    p2pConnection: null,
    activeUrl: null,
  }),
}));
vi.mock('@/session-first/terminal/useSessionFirstTerminalAttach', () => ({
  useSessionFirstTerminalAttach: () => ({ terminalState: 'idle', reconnectCount: 0 }),
}));
vi.mock('@/terminal/hooks/useTerminal', () => ({ useTerminal: () => null }));
vi.mock('@/hooks/useWebSocket', () => ({
  // The new-core WebSocketService surface: useTerminalOrchestration wraps the
  // service in a relayServerHandle and subscribes to connection-state changes
  // for the banner (durable 'connected'/'disconnected' edges). The remaining
  // members are inert — these tests never drive attach or relay I/O.
  useWebSocket: () => ({
    connectionState: 'connected',
    onConnectionStateChange: (cb: (state: ConnectionState) => void) => {
      wsListeners.push(cb);
      return () => {
        const i = wsListeners.indexOf(cb);
        if (i >= 0) {
          wsListeners.splice(i, 1);
        }
      };
    },
    beginRelay: vi.fn(),
    endRelay: vi.fn(),
    sendRelayInput: vi.fn(),
    sendRelayResize: vi.fn(),
    onRelayOutput: vi.fn(() => () => {}),
    onRelayResize: vi.fn(() => () => {}),
  }),
}));
vi.mock('@/session-first/terminal/SessionFirstTerminalPane', () => ({
  SessionFirstTerminalPane: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-first-terminal-pane">{sessionId}</div>
  ),
}));
vi.mock('@/session-first/terminal/TerminalSurface', () => ({
  TerminalSurface: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="session-first-terminal-surface">{children}</div>
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
    expect(screen.queryByTestId('session-first-terminal-pane')).not.toBeInTheDocument();
  });

  it('renders native TerminalSurface when a session is attached', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    renderTerminal(false, store);
    expect(screen.getByTestId('session-first-terminal-surface')).toBeInTheDocument();
  });

  it('keeps terminal pane mounted when hidden while a session is attached', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    const { rerenderHidden } = renderTerminal(false, store);

    const pane = screen.getByTestId('session-first-terminal-pane');
    expect(pane).toHaveTextContent('agent:sess');

    rerenderHidden(true);
    expect(screen.getByTestId('session-first-terminal').className).toMatch(/\bhidden\b/);
    expect(screen.getByTestId('session-first-terminal-pane')).toBe(pane);
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
