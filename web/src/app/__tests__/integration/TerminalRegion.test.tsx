import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { TerminalRegion } from '@/app/TerminalRegion';
import { sessionIdAtom, attachInfoAtom } from '@/product/session/state';
import { bannerAtomFamily, inputDropAtomFamily } from '@/product/terminal/state/ui';
import type { ConnectionState } from '@/platform/socket/types';

const { wsListeners, surfaceProps } = vi.hoisted(() => ({
  wsListeners: [] as Array<(state: ConnectionState) => void>,
  /**
   * What the region last handed the surface.
   *
   * The surface is mocked here, so this is the only place the *pass-through*
   * is observable at all — and it is worth observing, because dropping either
   * prop leaves every other test in the tree green: the orchestration still
   * fills the atom, the surface still knows how to render a notice, and no
   * notice ever appears.
   */
  surfaceProps: { current: null as Record<string, unknown> | null },
}));

vi.mock('@/product/terminal/hooks/useP2PAttachTransport', () => ({
  useP2PAttachTransport: () => ({
    waitingForAddressPlan: false,
    agentTerminalApi: null,
    connectionState: 'connected' as const,
    activeUrl: null,
  }),
}));
vi.mock('@/product/terminal/hooks/useTerminal', () => ({ useTerminal: () => null }));
vi.mock('@/shared/hooks/useWebSocket', () => ({
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
vi.mock('@/product/terminal/TerminalPane', () => ({
  TerminalPane: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-pane">{sessionId}</div>
  ),
}));
vi.mock('@/product/terminal/patterns/TerminalSurface', () => ({
  TerminalSurface: (props: { children: React.ReactNode }) => {
    surfaceProps.current = props as unknown as Record<string, unknown>;
    return <div data-testid="terminal-surface">{props.children}</div>;
  },
}));

function renderTerminal(hidden: boolean, store = createStore()) {
  const onDisconnect = vi.fn();
  const onError = vi.fn();
  const view = (
    <Provider store={store}>
      <TerminalRegion
        hidden={hidden}
        onDisconnect={onDisconnect}
        onError={onError}
        experience="web"
      />
    </Provider>
  );
  const result = render(view);
  return {
    ...result,
    store,
    rerenderHidden: (next: boolean) =>
      result.rerender(
        <Provider store={store}>
          <TerminalRegion
            hidden={next}
            onDisconnect={onDisconnect}
            onError={onError}
            experience="web"
          />
        </Provider>,
      ),
  };
}

describe('TerminalRegion', () => {
  beforeEach(() => {
    wsListeners.length = 0;
  });

  it('toggles CSS hidden without unmounting the keep-alive root', () => {
    const { rerenderHidden } = renderTerminal(false);
    const el = screen.getByTestId('terminal');
    expect(el.className).not.toMatch(/\bhidden\b/);

    rerenderHidden(true);
    const still = screen.getByTestId('terminal');
    expect(still).toBe(el);
    expect(still.className).toMatch(/\bhidden\b/);
  });

  it('shows a muted empty state when no session is selected', () => {
    renderTerminal(false);
    const root = screen.getByTestId('terminal');
    expect(root).toHaveTextContent('Select a session to open its terminal.');
    expect(screen.queryByTestId('terminal-pane')).not.toBeInTheDocument();
  });

  it('hands a lost-input notice to the surface, and takes the dismissal back (#1307 SC-09)', () => {
    // The middle of SC-09's chain. The orchestration proves the flow fills the
    // session's atom and the surface proves the atom renders; this is the two
    // lines between them, which nothing else covers — the region is the only
    // place both live, and a prop that stops being passed is invisible to
    // every test on either side of it.
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    renderTerminal(false, store);

    expect(surfaceProps.current?.inputDrop).toBeNull();

    act(() => {
      store.set(inputDropAtomFamily('agent:sess'), { reason: 'epoch', chunks: 1, at: 0 });
    });
    expect(surfaceProps.current?.inputDrop).toMatchObject({ reason: 'epoch' });

    // The way back, which is what makes the notice a decision rather than a
    // permanent banner: dismissing it is the surface's only action, and it has
    // to reach the same atom the notice came from.
    const dismiss = surfaceProps.current?.onDismissInputDrop;
    if (typeof dismiss !== 'function') {
      throw new Error('the region never passed a dismissal to the surface');
    }
    act(() => (dismiss as () => void)());
    expect(store.get(inputDropAtomFamily('agent:sess'))).toBeNull();
    expect(surfaceProps.current?.inputDrop).toBeNull();
  });

  it('renders native TerminalSurface when a session is attached', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    renderTerminal(false, store);
    expect(screen.getByTestId('terminal-surface')).toBeInTheDocument();
  });

  it('keeps terminal pane mounted when hidden while a session is attached', () => {
    const store = createStore();
    store.set(sessionIdAtom, 'agent:sess');
    const { rerenderHidden } = renderTerminal(false, store);

    const pane = screen.getByTestId('terminal-pane');
    expect(pane).toHaveTextContent('agent:sess');

    rerenderHidden(true);
    expect(screen.getByTestId('terminal').className).toMatch(/\bhidden\b/);
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
