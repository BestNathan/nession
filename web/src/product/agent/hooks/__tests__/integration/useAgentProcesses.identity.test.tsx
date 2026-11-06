import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '@/types';
import type {
  DiscoveredProcess,
  ProcessMetric,
  ProcessSnapshot,
} from '@/product/agent/types';
import type { DomainState } from '@/product/session/model/domainState';

const api = vi.hoisted(() => {
  const state: { listener: (() => void) | null } = { listener: null };
  return {
    fetchProcessSnapshot: vi.fn(),
    connectionRevision: vi.fn(() => 1),
    onConnectionChange: vi.fn((listener: () => void) => {
      state.listener = listener;
      return () => {
        state.listener = null;
      };
    }),
    state,
  };
});

vi.mock('@/product/session', () => ({ sessionsApi: api }));

import { AgentDetail } from '@/product/agent/patterns/AgentDetail';
import { useAgentProcesses } from '@/product/agent/hooks/useAgentProcesses';

const state: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};

function agentWith(agentId: string, status: Agent['status'] = 'online'): Agent {
  return {
    agent_id: agentId,
    hostname: agentId,
    display_name: agentId,
    ip_address: '10.0.0.1',
    port: 19091,
    status,
    session_count: 1,
    last_heartbeat: '2026-01-01T00:00:00Z',
  };
}

const agentA = agentWith('agent-a');
const agentB = agentWith('agent-b');
const agentBOffline = agentWith('agent-b', 'offline');

function metric(value: number, metricState: ProcessMetric['state'] = 'sampled'): ProcessMetric {
  return { value, state: metricState, reason: metricState === 'sampled' ? undefined : 'no_io_counters' };
}

function process(pid: number, command: string): DiscoveredProcess {
  return {
    pid,
    parent_pid: 1,
    start_time_ms: 1_700_000_000_000 + pid,
    tty: '/dev/pts/1',
    sid: 10,
    pgid: 10,
    executable: command.split(' ')[0],
    command,
    command_state: 'sampled',
    redacted: command.includes('[REDACTED]'),
    truncated: false,
    cpu_percent: metric(10),
    rss_mib: metric(4),
    threads: metric(1),
    elapsed_ms: metric(60_000),
    io_read_kib_per_s: metric(0),
    io_write_kib_per_s: metric(0),
  };
}

function snapshotFor(sessionName: string, pid: number, command: string): ProcessSnapshot {
  return {
    session_name: sessionName,
    snapshot_at_ms: 1_700_000_100_000,
    platform: 'linux',
    methods: ['process_tree'],
    panes: [
      {
        session_ids: ['$0'],
        session_names: [sessionName],
        window_id: '@0',
        window_index: 0,
        window_name: 'shell',
        pane_id: '%0',
        pane_index: 0,
        pane_pid: pid,
        pane_tty: '/dev/pts/1',
        method: 'process_tree',
        coverage: 'partial',
        reason_codes: ['no_dedicated_cgroup'],
        processes: [process(pid, command)],
      },
    ],
    truncated: false,
    limits: { max_processes: 512, max_depth: 32, cpu_window_ms: 150 },
  };
}

const COMMAND_A = 'agent-a-worker --task alpha --auth [REDACTED]';
const COMMAND_B = 'agent-b-worker --task beta';
const snapshotA = snapshotFor('dev', 4101, COMMAND_A);
const snapshotB = snapshotFor('dev', 4201, COMMAND_B);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function stubMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

function renderDetail(agent: Agent, sessionId: string | null) {
  return render(<AgentDetail agent={agent} state={state} currentSessionId={sessionId} />);
}

describe('Agent Processes Session identity', () => {
  beforeEach(() => {
    api.fetchProcessSnapshot.mockReset();
    api.connectionRevision.mockReset().mockReturnValue(1);
    api.onConnectionChange.mockClear();
    api.state.listener = null;
    stubMedia(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('SC-01: switching to another Agent with the same Session name renders no previous rows when the Agent is offline', async () => {
    api.fetchProcessSnapshot.mockResolvedValue(snapshotA);

    const { rerender } = renderDetail(agentA, 'agent-a:dev');
    expect(await screen.findByText(COMMAND_A)).toBeInTheDocument();

    rerender(<AgentDetail agent={agentBOffline} state={state} currentSessionId="agent-b:dev" />);

    // The visible identity is already Agent B's Session; no frame may keep
    // Agent A's rows, inspector, or snapshot header under it.
    expect(screen.getByTestId('agent-process-session')).toHaveTextContent('dev');
    expect(screen.queryByText(COMMAND_A)).not.toBeInTheDocument();
    expect(screen.queryByTestId('process-forest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('process-inspector')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-process-diagnostics')).not.toBeInTheDocument();

    expect(await screen.findByTestId('agent-processes-offline')).toBeInTheDocument();
    expect(await screen.findByTestId('agent-processes-error')).not.toHaveTextContent(
      /Showing the last snapshot/,
    );
    expect(api.fetchProcessSnapshot).toHaveBeenCalledTimes(1);
    expect(api.fetchProcessSnapshot).not.toHaveBeenCalledWith('agent-b:dev');
  });

  it('SC-01: switching to another Agent with the same Session name renders no previous rows when the read rejects', async () => {
    api.fetchProcessSnapshot.mockImplementation((sessionId: string) =>
      sessionId === 'agent-a:dev'
        ? Promise.resolve(snapshotA)
        : Promise.reject(new Error('agent-b discovery failed')),
    );

    const { rerender } = renderDetail(agentA, 'agent-a:dev');
    expect(await screen.findByText(COMMAND_A)).toBeInTheDocument();

    rerender(<AgentDetail agent={agentB} state={state} currentSessionId="agent-b:dev" />);

    expect(screen.queryByText(COMMAND_A)).not.toBeInTheDocument();
    expect(screen.queryByTestId('process-forest')).not.toBeInTheDocument();

    const error = await screen.findByTestId('agent-processes-error');
    expect(error).toHaveTextContent('agent-b discovery failed');
    // The failure belongs to B and there is no B snapshot to call stale: it
    // must not offer Agent A's snapshot as B's last-known data.
    expect(error).not.toHaveTextContent('Showing the last snapshot');
    expect(screen.queryByText(COMMAND_A)).not.toBeInTheDocument();
    expect(screen.queryByTestId('process-forest')).not.toBeInTheDocument();
  });

  it('SC-01: switching to another Agent with the same Session name stays pending without the previous rows', async () => {
    const pendingB = deferred<ProcessSnapshot>();
    api.fetchProcessSnapshot.mockImplementation((sessionId: string) =>
      sessionId === 'agent-a:dev' ? Promise.resolve(snapshotA) : pendingB.promise,
    );

    const { rerender } = renderDetail(agentA, 'agent-a:dev');
    expect(await screen.findByText(COMMAND_A)).toBeInTheDocument();

    rerender(<AgentDetail agent={agentB} state={state} currentSessionId="agent-b:dev" />);

    expect(screen.queryByText(COMMAND_A)).not.toBeInTheDocument();
    expect(screen.queryByTestId('process-forest')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-processes-snapshot-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-processes-error')).not.toBeInTheDocument();

    await act(async () => {
      pendingB.resolve(snapshotB);
    });

    expect(await screen.findByText(COMMAND_B)).toBeInTheDocument();
    expect(screen.queryByText(COMMAND_A)).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-processes-snapshot-loading')).not.toBeInTheDocument();
  });

  it('SC-01: a late response for the previous Agent cannot repopulate the new Session', async () => {
    const pendingA = deferred<ProcessSnapshot>();
    const pendingB = deferred<ProcessSnapshot>();
    api.fetchProcessSnapshot.mockImplementation((sessionId: string) =>
      sessionId === 'agent-a:dev' ? pendingA.promise : pendingB.promise,
    );

    const { rerender } = renderDetail(agentA, 'agent-a:dev');
    await waitFor(() => expect(api.fetchProcessSnapshot).toHaveBeenCalledWith('agent-a:dev'));

    rerender(<AgentDetail agent={agentB} state={state} currentSessionId="agent-b:dev" />);
    await waitFor(() => expect(api.fetchProcessSnapshot).toHaveBeenCalledWith('agent-b:dev'));

    await act(async () => {
      pendingB.resolve(snapshotB);
    });
    expect(await screen.findByText(COMMAND_B)).toBeInTheDocument();

    await act(async () => {
      pendingA.resolve(snapshotA);
    });

    expect(screen.queryByText(COMMAND_A)).not.toBeInTheDocument();
    expect(screen.getByText(COMMAND_B)).toBeInTheDocument();
    expect(screen.queryByTestId('agent-processes-error')).not.toBeInTheDocument();
  });

  interface ProbeFrame {
    sessionId: string | null;
    command: string | null;
    error: string | null;
  }

  function probeFrames(frames: ProbeFrame[]) {
    function Probe({ agent, sessionId }: { agent: Agent; sessionId: string | null }) {
      const view = useAgentProcesses(agent, sessionId);
      frames.push({
        sessionId: view.sessionId,
        command: view.snapshot?.panes[0]?.processes[0]?.command ?? null,
        error: view.snapshotError,
      });
      return <div data-testid="probe" data-session={view.sessionId ?? ''} />;
    }
    return Probe;
  }

  it('SC-01: the first render frame with the new Session identity carries no previous snapshot', async () => {
    const frames: ProbeFrame[] = [];
    const Probe = probeFrames(frames);
    const pendingB = deferred<ProcessSnapshot>();
    api.fetchProcessSnapshot.mockImplementation((sessionId: string) =>
      sessionId === 'agent-a:dev' ? Promise.resolve(snapshotA) : pendingB.promise,
    );

    // The effect-free frame is the interval before any effect can clear state;
    // every frame tagged with B must already be free of A's observation.
    const { rerender } = render(<Probe agent={agentA} sessionId="agent-a:dev" />);
    await waitFor(() => expect(frames.some((frame) => frame.command === COMMAND_A)).toBe(true));

    rerender(<Probe agent={agentB} sessionId="agent-b:dev" />);

    const bFrames = frames.filter((frame) => frame.sessionId === 'agent-b:dev');
    expect(bFrames.length).toBeGreaterThan(0);
    for (const frame of bFrames) {
      expect(frame.command).toBeNull();
      expect(frame.error).toBeNull();
    }

    await act(async () => {
      pendingB.resolve(snapshotB);
    });
    expect(frames.some((frame) => frame.command === COMMAND_B)).toBe(true);
  });

  it('SC-01: the first render frame with the new Session identity carries no previous error', async () => {
    const frames: ProbeFrame[] = [];
    const Probe = probeFrames(frames);
    const pendingB = deferred<ProcessSnapshot>();
    api.fetchProcessSnapshot.mockImplementation((sessionId: string) =>
      sessionId === 'agent-a:dev'
        ? Promise.reject(new Error('agent-a failed'))
        : pendingB.promise,
    );

    const { rerender } = render(<Probe agent={agentA} sessionId="agent-a:dev" />);
    await waitFor(() => expect(frames.some((frame) => frame.error === 'agent-a failed')).toBe(true));

    rerender(<Probe agent={agentB} sessionId="agent-b:dev" />);

    const bFrames = frames.filter((frame) => frame.sessionId === 'agent-b:dev');
    expect(bFrames.length).toBeGreaterThan(0);
    for (const frame of bFrames) {
      expect(frame.command).toBeNull();
      expect(frame.error).toBeNull();
    }
  });

  it('SC-02: a refresh failure for the same full Session ID retains its snapshot as stale', async () => {
    api.fetchProcessSnapshot
      .mockReset()
      .mockResolvedValueOnce(snapshotA)
      .mockRejectedValueOnce(new Error('agent timed out'));

    renderDetail(agentA, 'agent-a:dev');
    expect(await screen.findByText(COMMAND_A)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh process snapshot' }));

    const error = await screen.findByTestId('agent-processes-error');
    expect(error).toHaveTextContent('agent timed out');
    expect(error).toHaveTextContent('Showing the last snapshot');
    expect(screen.getByText(COMMAND_A)).toBeInTheDocument();
    expect(screen.getByTestId('process-forest')).toBeInTheDocument();
  });

  it('SC-02: an offline same full Session ID retains its snapshot as stale', async () => {
    api.fetchProcessSnapshot.mockResolvedValue(snapshotA);

    const { rerender } = renderDetail(agentA, 'agent-a:dev');
    expect(await screen.findByText(COMMAND_A)).toBeInTheDocument();

    rerender(<AgentDetail agent={{ ...agentA, status: 'offline' }} state={state} currentSessionId="agent-a:dev" />);

    expect(await screen.findByTestId('agent-processes-offline')).toBeInTheDocument();
    expect(screen.getByText(COMMAND_A)).toBeInTheDocument();
    const error = await screen.findByTestId('agent-processes-error');
    expect(error).toHaveTextContent('Agent offline');
    expect(error).toHaveTextContent('Showing the last snapshot');
  });

  it('SC-02: a distinct Session ID with a different name never retains the previous snapshot', async () => {
    api.fetchProcessSnapshot.mockImplementation((sessionId: string) =>
      sessionId === 'agent-a:other'
        ? Promise.reject(new Error('agent-a discovery failed'))
        : Promise.resolve(snapshotB),
    );

    const { rerender } = renderDetail(agentB, 'agent-b:dev');
    expect(await screen.findByText(COMMAND_B)).toBeInTheDocument();

    rerender(<AgentDetail agent={agentA} state={state} currentSessionId="agent-a:other" />);

    expect(screen.queryByText(COMMAND_B)).not.toBeInTheDocument();
    expect(screen.queryByTestId('process-forest')).not.toBeInTheDocument();
    expect(await screen.findByTestId('agent-processes-error')).toHaveTextContent(
      'agent-a discovery failed',
    );
    expect(screen.queryByText(COMMAND_B)).not.toBeInTheDocument();
  });

  it('SC-02: no current Session stays empty and reads nothing', async () => {
    api.fetchProcessSnapshot.mockClear();

    render(<AgentDetail agent={agentA} state={state} />);

    expect(await screen.findByTestId('agent-processes-no-session')).toBeInTheDocument();
    expect(api.fetchProcessSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByTestId('process-forest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-process-session')).not.toBeInTheDocument();
  });

  it('SC-03: a Session switch resets the selected process and returning to the first Agent recovers', async () => {
    const pendingB = deferred<ProcessSnapshot>();
    api.fetchProcessSnapshot.mockImplementation((sessionId: string) => {
      if (sessionId === 'agent-a:dev') {
        return Promise.resolve(snapshotA);
      }
      if (sessionId === 'agent-b:dev') {
        return pendingB.promise;
      }
      return Promise.reject(new Error(`unexpected Session ${sessionId}`));
    });

    const { rerender } = renderDetail(agentA, 'agent-a:dev');
    fireEvent.click(await screen.findByText(COMMAND_A));
    expect(screen.getByTestId('process-inspector')).toHaveTextContent(COMMAND_A);

    // Same Session name, different full identity: the selected PID must not
    // survive into B, and B's pending state must not carry A's rows.
    rerender(<AgentDetail agent={agentB} state={state} currentSessionId="agent-b:dev" />);
    expect(screen.queryByTestId('process-inspector')).not.toBeInTheDocument();
    expect(screen.queryByText(COMMAND_A)).not.toBeInTheDocument();

    await act(async () => {
      pendingB.resolve(snapshotB);
    });
    expect(await screen.findByText(COMMAND_B)).toBeInTheDocument();
    expect(screen.queryByTestId('process-inspector')).not.toBeInTheDocument();

    // Selecting B's process works; returning to A is a new observation and
    // recovers A's snapshot without B's selection or rows.
    fireEvent.click(screen.getByText(COMMAND_B));
    expect(screen.getByTestId('process-inspector')).toHaveTextContent(COMMAND_B);

    rerender(<AgentDetail agent={agentA} state={state} currentSessionId="agent-a:dev" />);
    expect(await screen.findByText(COMMAND_A)).toBeInTheDocument();
    expect(screen.queryByText(COMMAND_B)).not.toBeInTheDocument();
    expect(screen.queryByTestId('process-inspector')).not.toBeInTheDocument();
  });
});
