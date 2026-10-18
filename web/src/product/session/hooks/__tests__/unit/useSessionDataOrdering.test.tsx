// @vitest-environment jsdom
// #1900 — executable DOM proof for the default unit Gate, in addition to the
// comprehensive integration hook tests. A real SessionItem must render the
// server's latest command; a stale list response must not rewind it to unknown.
import '@/test/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import type { Session } from '@/types';
import type { DomainState } from '@/product/session/model/domainState';
import { SessionItem } from '@/product/session/patterns/SessionItem';
import { useSessionData } from '@/product/session/hooks/useSessionData';
import { sessionsApi } from '@/product/session';

const fake = vi.hoisted(() => ({
  fetch: vi.fn(),
  listeners: new Set<(sessions: Session[]) => void>(),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/product/session', () => ({
  sessionsApi: {
    fetchSessions: fake.fetch,
    onSessionsChanged: (cb: (sessions: Session[]) => void) => {
      fake.listeners.add(cb);
      return () => fake.listeners.delete(cb);
    },
  },
}));

const state: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};
function row(foreground_command: string | null): Session {
  return {
    session_id: 'node:live', agent_id: 'node', session_name: 'live',
    foreground_command, status: 'detached', window_count: 1,
    attached_clients: 0, last_activity: '2026-10-18T00:00:00Z',
  };
}

let current: ReturnType<typeof useSessionData>;
function SessionScreen() {
  const data = useSessionData();
  current = data;
  // Exactly the production subscription owner in useRealtimeUpdates:
  // server.sessions.changed -> applyRealtimeSessions -> SessionItem.
  useEffect(() =>
    sessionsApi.onSessionsChanged(data.applyRealtimeSessions),
  [data.applyRealtimeSessions]);

  return (
    <main>
      {data.sessions.map((session) => (
        <SessionItem
          key={session.session_id} session={session}
          domain={state} agentLabel="node" selected={false}
          onSelect={() => {}}
        />
      ))}
    </main>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.listeners.clear();
});
afterEach(() => {
  cleanup();
  fake.listeners.clear();
});

function push(sessions: Session[]) {
  expect(fake.listeners.size).toBe(1); // proves the push had a subscriber
  act(() => { for (const cb of fake.listeners) cb(sessions); });
}

describe('#1900 SessionItem live report/list ordering (real DOM)', () => {
  it('renders bash after a real push and rejects a late stale unknown list', async () => {
    let resolve!: (value: { sessions: Session[]; stale_agents?: string[] }) => void;
    fake.fetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<SessionScreen />);
    let pending!: Promise<void>;
    act(() => { pending = current.fetchSessions(); });

    // A report definitely arrived and updated the actual SessionItem. This
    // excludes "missing push" from this reproduction's failure mechanism.
    push([row('bash')]);
    expect(screen.getByTestId('session-item-workload')).toHaveTextContent('bash');

    await act(async () => {
      resolve({ sessions: [row(null)], stale_agents: ['node'] });
      await pending;
    });
    expect(screen.getByTestId('session-item-workload')).toHaveTextContent('bash');
    expect(current.staleAgents).toEqual([]);
  });

  it('displays unknown when the push is truly missing, then permits clear', async () => {
    fake.fetch.mockResolvedValue({ sessions: [row(null)] });
    render(<SessionScreen />);
    await act(async () => { await current.fetchSessions(); });
    expect(screen.getByTestId('session-item-workload')).toHaveTextContent('unknown');

    push([row('bash')]);
    expect(screen.getByTestId('session-item-workload')).toHaveTextContent('bash');

    // Foreground command removal is legitimate new server truth, not a
    // permanent cache in which "bash wins".
    push([row(null)]);
    expect(screen.getByTestId('session-item-workload')).toHaveTextContent('unknown');
    push([]);
    expect(screen.queryByTestId('session-item-workload')).toBeNull();
  });
});
