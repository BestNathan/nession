import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { SessionDropdown } from '../SessionDropdown';
import { WebSocketContext } from '../../hooks/useWebSocket';
import { sessionIdAtom } from '../../atoms/session';
import type { Session } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import type { useAddressProbeCache } from '../../hooks/useAddressProbeCache';

// SessionDropdown navigates via useNavigate on attach; stub it so the component
// can render outside a Router and we can assert the target path.
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'agent1:test',
    agent_id: 'agent1',
    session_name: 'test',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const mockProbeCache = {
  getProbe: vi.fn().mockReturnValue(undefined),
  refreshAgent: vi.fn(),
} as unknown as ReturnType<typeof useAddressProbeCache>;

function makeWsService() {
  return {
    killSession: vi.fn().mockResolvedValue({ success: true }),
    listSessions: vi.fn().mockResolvedValue([]),
    requestAttach: vi.fn().mockResolvedValue({}),
    listEnvFiles: vi.fn().mockResolvedValue({ files: [] }),
    isConnected: vi.fn().mockReturnValue(true),
  } as unknown as WebSocketService;
}

describe('SessionDropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDropdown(props: Partial<{
    sessions: Session[];
    loading: boolean;
    error: string | null;
    currentSessionId: string;
    currentSessionName: string;
  }> = {}) {
    const ws = makeWsService();
    const store = createStore();
    store.set(sessionIdAtom, props.currentSessionId ?? 'agent1:current');
    return {
      store,
      ...render(
        <Provider store={store}>
          <WebSocketContext.Provider value={ws}>
            <SessionDropdown
              sessions={props.sessions ?? []}
              loading={props.loading ?? false}
              error={props.error ?? null}
              onRetry={vi.fn()}
              currentSessionName={props.currentSessionName ?? 'current'}
              probeCache={mockProbeCache}
            />
          </WebSocketContext.Provider>
        </Provider>,
      ),
    };
  }

  it('renders trigger with current session name', () => {
    renderDropdown({ currentSessionName: 'mysession' });
    expect(screen.getByText('mysession')).toBeDefined();
    expect(screen.getByText('Session:')).toBeDefined();
  });

  it('shows session rows when opened', async () => {
    renderDropdown({
      sessions: [
        makeSession({ session_id: 'a:alpha', session_name: 'alpha' }),
        makeSession({ session_id: 'b:beta', session_name: 'beta' }),
      ],
      currentSessionId: 'a:alpha',
    });

    await userEvent.click(screen.getByText('current'));

    expect(await screen.findByText('beta')).toBeDefined();
    expect(screen.getByText('alpha')).toBeDefined();
  });

  it('shows loading skeletons when loading', async () => {
    renderDropdown({ loading: true });

    await userEvent.click(screen.getByText('current'));
    await screen.findByPlaceholderText('Filter sessions...');

    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows empty state when no sessions', async () => {
    renderDropdown({ sessions: [], loading: false });

    await userEvent.click(screen.getByText('current'));

    expect(await screen.findByText('No active sessions')).toBeDefined();
  });

  it('shows error with retry button', async () => {
    const onRetry = vi.fn();
    const ws = makeWsService();
    const store = createStore();
    store.set(sessionIdAtom, 'agent1:current');
    render(
      <Provider store={store}>
        <WebSocketContext.Provider value={ws}>
          <SessionDropdown
            sessions={[]}
            loading={false}
            error="fetch failed"
            onRetry={onRetry}
            currentSessionName="current"
            probeCache={mockProbeCache}
          />
        </WebSocketContext.Provider>
      </Provider>,
    );

    await userEvent.click(screen.getByText('current'));

    expect(await screen.findByText('fetch failed')).toBeDefined();
    expect(screen.getByText('Retry')).toBeDefined();
  });

  it('filters sessions by search query', async () => {
    renderDropdown({
      sessions: [
        makeSession({ session_id: 'a:alpha', session_name: 'alpha' }),
        makeSession({ session_id: 'b:beta', session_name: 'beta' }),
      ],
    });

    await userEvent.click(screen.getByText('current'));

    const input = await screen.findByPlaceholderText('Filter sessions...');
    await userEvent.type(input, 'alpha');

    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.queryByText('beta')).toBeNull();
  });

  it('no-match message when search filters everything', async () => {
    renderDropdown({
      sessions: [makeSession({ session_name: 'alpha' })],
    });

    await userEvent.click(screen.getByText('current'));

    const input = await screen.findByPlaceholderText('Filter sessions...');
    await userEvent.type(input, 'xyz');

    expect(await screen.findByText('No sessions match your search')).toBeDefined();
  });

  it('opens AttachDialog when clicking a non-current session row', async () => {
    renderDropdown({
      sessions: [
        makeSession({ session_id: 'a:current', session_name: 'current' }),
        makeSession({ session_id: 'b:beta', session_name: 'beta' }),
      ],
      currentSessionId: 'a:current',
    });

    await userEvent.click(screen.getByText('current'));
    await screen.findByText('beta');

    await userEvent.click(screen.getByText('beta'));

    expect(await screen.findByText('Attach: beta')).toBeDefined();

    // Cancelling closes the dialog without switching.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Attach: beta')).toBeNull();
  });

  it('confirms attach choice through AttachDialog', async () => {
    const ws = makeWsService();
    const store = createStore();
    store.set(sessionIdAtom, 'a:current');
    render(
      <Provider store={store}>
        <WebSocketContext.Provider value={ws}>
          <SessionDropdown
            sessions={[
              makeSession({ session_id: 'a:current', session_name: 'current' }),
              makeSession({ session_id: 'b:beta', session_name: 'beta' }),
            ]}
            loading={false}
            error={null}
            onRetry={vi.fn()}
            currentSessionName="current"
            probeCache={mockProbeCache}
          />
        </WebSocketContext.Provider>
      </Provider>,
    );

    await userEvent.click(screen.getByText('current'));
    await screen.findByText('beta');
    await userEvent.click(screen.getByText('beta'));
    await screen.findByText('Attach: beta');

    const attachBtn = screen.getByRole('button', { name: 'Attach' });
    await waitFor(() => expect(attachBtn).not.toBeDisabled());
    await userEvent.click(attachBtn);

    // Confirm now runs attachToSessionAtom: it writes the base atoms and navigates.
    expect(store.get(sessionIdAtom)).toBe('b:beta');
    expect(navigateMock).toHaveBeenCalledWith('/terminal/b%3Abeta');
  });

  it('Kill button opens KillConfirmDialog without selecting the row', async () => {
    const ws = makeWsService();
    const store = createStore();
    store.set(sessionIdAtom, 'a:current');
    render(
      <Provider store={store}>
        <WebSocketContext.Provider value={ws}>
          <SessionDropdown
            sessions={[
              makeSession({ session_id: 'a:current', session_name: 'current' }),
              makeSession({ session_id: 'b:beta', session_name: 'beta' }),
            ]}
            loading={false}
            error={null}
            onRetry={vi.fn()}
            currentSessionName="current"
            probeCache={mockProbeCache}
          />
        </WebSocketContext.Provider>
      </Provider>,
    );

    await userEvent.click(screen.getByText('current'));
    await screen.findByText('beta');

    const killButtons = screen.getAllByText('Kill');
    await userEvent.click(killButtons[0]);

    const confirmBtn = await screen.findByRole('button', { name: 'Kill Session' });
    // stopPropagation on the Kill button must prevent the row select / AttachDialog.
    expect(screen.queryByText('Attach: beta')).toBeNull();

    await userEvent.click(confirmBtn);

    expect(ws.killSession).toHaveBeenCalledWith('b:beta');
    // Dialog closes after a successful kill.
    expect(screen.queryByText('Kill Session')).toBeNull();
  });

  it('clicking the current session row does not open AttachDialog', async () => {
    renderDropdown({
      sessions: [makeSession({ session_id: 'a:current', session_name: 'current' })],
      currentSessionId: 'a:current',
    });

    await userEvent.click(screen.getByText('current'));
    const option = await screen.findByRole('option');
    await userEvent.click(option);

    expect(screen.queryByText('Attach: current')).toBeNull();
  });

  it('renders detached and zombie status suffixes', async () => {
    renderDropdown({
      sessions: [
        makeSession({ session_id: 'd:det', session_name: 'det', status: 'detached', attached_clients: 1 }),
        makeSession({ session_id: 'z:zom', session_name: 'zom', status: 'zombie' }),
      ],
      currentSessionId: 'a:current',
    });

    await userEvent.click(screen.getByText('current'));
    await screen.findByText('det');

    // Singular "client" (no trailing "s") for exactly 1 attached client.
    expect(screen.getByText(/1 client · detached/)).toBeDefined();
    expect(screen.getByText(/· zombie/)).toBeDefined();
  });
});
