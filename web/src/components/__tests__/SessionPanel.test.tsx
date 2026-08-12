import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionPanel } from '../SessionPanel';
import { WebSocketContext } from '../../hooks/useWebSocket';
import type { Session } from '../../types';
import type { WebSocketService } from '../../services/websocket';

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

function makeWsService() {
  return {
    killSession: vi.fn().mockResolvedValue({ success: true }),
    listSessions: vi.fn().mockResolvedValue([]),
    requestAttach: vi.fn().mockResolvedValue({}),
    isConnected: vi.fn().mockReturnValue(true),
  } as unknown as WebSocketService;
}

describe('SessionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderPanel(props: Partial<{
    sessions: Session[];
    loading: boolean;
    error: string | null;
    currentSessionId: string;
  }> = {}) {
    const ws = makeWsService();
    return render(
      <WebSocketContext.Provider value={ws}>
        {/* These tests exercise SessionPanel content, not the collapsed state —
            force the SidePanel open so children are mounted. */}
        <SessionPanel
          defaultOpen={true}
          sessions={props.sessions ?? []}
          loading={props.loading ?? false}
          error={props.error ?? null}
          onRetry={vi.fn()}
          currentSessionId={props.currentSessionId ?? 'agent1:current'}
          onSwitchSession={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );
  }

  it('shows loading skeletons when loading=true', () => {
    renderPanel({ loading: true });
    // Skeletons are present — they use Skeleton which renders animate-pulse div
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows empty state when no sessions', () => {
    renderPanel({ sessions: [], loading: false });
    expect(screen.getByText('No active sessions')).toBeDefined();
  });

  it('shows error banner with retry button', () => {
    const onRetry = vi.fn();
    const ws = makeWsService();
    render(
      <WebSocketContext.Provider value={ws}>
        <SessionPanel
          defaultOpen={true}
          sessions={[]}
          loading={false}
          error="fetch failed"
          onRetry={onRetry}
          currentSessionId="agent1:current"
          onSwitchSession={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    expect(screen.getByText('fetch failed')).toBeDefined();
    expect(screen.getByText('Retry')).toBeDefined();
  });

  it('renders session rows with Attach and Kill buttons', () => {
    renderPanel({
      sessions: [makeSession({ session_name: 'mysession', status: 'active' })],
      loading: false,
      currentSessionId: 'agent1:other',
    });

    expect(screen.getByText('mysession')).toBeDefined();
    expect(screen.getByText('Attach')).toBeDefined();
    expect(screen.getByText('Kill')).toBeDefined();
  });

  it('highlights current session with badge and hides Attach button', () => {
    renderPanel({
      sessions: [makeSession({ session_id: 'agent1:current', session_name: 'current' })],
      loading: false,
      currentSessionId: 'agent1:current',
    });

    expect(screen.getByText('Current')).toBeDefined();
    // No Attach button for current session
    const attachButtons = screen.queryAllByText('Attach');
    expect(attachButtons.length).toBe(0);
  });

  it('filters sessions by search query', async () => {
    renderPanel({
      sessions: [
        makeSession({ session_id: 'a:a', session_name: 'alpha' }),
        makeSession({ session_id: 'b:b', session_name: 'beta' }),
      ],
      loading: false,
    });

    const input = screen.getByPlaceholderText('Filter sessions...');
    await userEvent.type(input, 'alpha');

    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.queryByText('beta')).toBeNull();
  });

  it('shows no-match message when search filters everything', async () => {
    renderPanel({
      sessions: [makeSession({ session_name: 'alpha' })],
      loading: false,
    });

    const input = screen.getByPlaceholderText('Filter sessions...');
    await userEvent.type(input, 'xyz');

    expect(screen.getByText('No sessions match your search')).toBeDefined();
  });

  it('disables Attach button for zombie sessions', () => {
    renderPanel({
      sessions: [makeSession({ session_name: 'zombie', status: 'zombie' })],
      loading: false,
      currentSessionId: 'agent1:other',
    });

    const attachBtn = screen.getByText('Attach');
    expect(attachBtn.hasAttribute('disabled')).toBe(true);
  });
});
