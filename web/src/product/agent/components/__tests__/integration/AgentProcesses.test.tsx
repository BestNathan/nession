import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, Session } from '@/types';
import type { DiscoveredProcess, ProcessMetric, ProcessSnapshot } from '@/product/agent/types';
import type { DomainState } from '@/product/session/model/domainState';

const api = vi.hoisted(() => ({
  listSessions: vi.fn(),
  fetchProcessSnapshot: vi.fn(),
}));

vi.mock('@/product/session', () => ({ sessionsApi: api }));

import { AgentDetail } from '@/product/agent/patterns/AgentDetail';

const state: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};

const agent: Agent = {
  agent_id: 'a1',
  hostname: 'devbox-01',
  display_name: 'devbox-01',
  ip_address: '10.0.0.1',
  port: 19091,
  status: 'online',
  session_count: 1,
  last_heartbeat: '2026-01-01T00:00:00Z',
};

const session: Session = {
  session_id: 'a1:s1',
  agent_id: 'a1',
  session_name: 's1',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: '2026-01-01T00:00:00Z',
};

function metric(value: number | null, state: ProcessMetric['state'] = 'sampled'): ProcessMetric {
  return { value: value ?? undefined, state, reason: state === 'sampled' ? undefined : 'no_io_counters' };
}

function process(pid: number, parent: number | null, overrides: Partial<DiscoveredProcess> = {}): DiscoveredProcess {
  return {
    pid,
    parent_pid: parent,
    start_time_ms: 1_700_000_000_000,
    tty: '/dev/pts/1',
    sid: 10,
    pgid: 10,
    executable: 'tool',
    command: 'tool',
    command_state: 'sampled',
    redacted: false,
    truncated: false,
    cpu_percent: metric(10),
    rss_mib: metric(4),
    threads: metric(1),
    elapsed_ms: metric(60_000),
    io_read_kib_per_s: metric(0),
    io_write_kib_per_s: metric(0),
    ...overrides,
  };
}

const snapshot: ProcessSnapshot = {
  session_name: 's1',
  snapshot_at_ms: 1_700_000_100_000,
  platform: 'linux',
  methods: ['process_tree'],
  panes: [
    {
      session_ids: ['$0'],
      session_names: ['s1'],
      window_id: '@0',
      window_index: 0,
      window_name: 'shell',
      pane_id: '%0',
      pane_index: 0,
      pane_pid: 10,
      pane_tty: '/dev/pts/1',
      method: 'process_tree',
      coverage: 'partial',
      reason_codes: ['no_dedicated_cgroup', 'sid_tty_association'],
      processes: [
        process(10, 1, {
          command: 'bash -l --token [REDACTED]',
          redacted: true,
        }),
        process(11, 10, {
          command: 'sleep 30',
          cpu_percent: metric(20),
          io_read_kib_per_s: metric(null, 'unsupported'),
        }),
      ],
    },
  ],
  truncated: false,
  limits: { max_processes: 512, max_depth: 32, cpu_window_ms: 150 },
};

describe('Agent Processes workspace', () => {
  beforeEach(() => {
    api.listSessions.mockReset().mockResolvedValue([session]);
    api.fetchProcessSnapshot.mockReset().mockResolvedValue(snapshot);
  });

  it('drills down from the Agent to Panes and a command-first inspector', async () => {
    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);

    expect(await screen.findByTestId('process-pane-%0')).toBeInTheDocument();
    const pane = screen.getByTestId('process-pane-%0');
    expect(within(pane).getByText(/No verified per-pane cgroup/)).toBeInTheDocument();
    expect(pane).toHaveTextContent('Partial');

    fireEvent.click(screen.getByText('bash -l --token [REDACTED]'));

    const inspector = await screen.findByTestId('process-inspector');
    expect(within(inspector).getByTestId('process-command')).toHaveTextContent(
      'bash -l --token [REDACTED]',
    );
    expect(within(inspector).getByText('redacted')).toBeInTheDocument();
    expect(within(screen.getByTestId('process-metric-cpu')).getByText('10.0%')).toBeInTheDocument();
  });

  it('aggregates PPID descendants and refuses to total a missing metric', async () => {
    render(<AgentDetail agent={agent} state={state} />);
    fireEvent.click(await screen.findByText('bash -l --token [REDACTED]'));

    fireEvent.click(screen.getByRole('button', { name: 'With descendants' }));

    expect(within(screen.getByTestId('process-metric-cpu')).getByText('30.0%')).toBeInTheDocument();
    expect(within(screen.getByTestId('process-metric-read')).getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/2 processes · includes PID 10/)).toBeInTheDocument();
  });

  it('copies only the sanitized display string', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<AgentDetail agent={agent} state={state} />);
    fireEvent.click(await screen.findByText('bash -l --token [REDACTED]'));
    fireEvent.click(screen.getByRole('button', { name: /Copy command/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('bash -l --token [REDACTED]'),
    );
  });

  it('does not pretend an offline Agent answered', async () => {
    api.fetchProcessSnapshot.mockClear();
    render(<AgentDetail agent={{ ...agent, status: 'offline' }} state={state} />);

    expect(await screen.findByTestId('agent-processes-offline')).toBeInTheDocument();
    expect(api.fetchProcessSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the last snapshot and marks it stale when a refresh fails', async () => {
    api.fetchProcessSnapshot
      .mockReset()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error('agent timed out'));

    render(<AgentDetail agent={agent} state={state} />);
    await screen.findByTestId('process-pane-%0');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh process snapshot' }));

    const error = await screen.findByTestId('agent-processes-error');
    expect(error).toHaveTextContent('agent timed out');
    expect(error).toHaveTextContent('Showing the last snapshot');
    expect(screen.getByTestId('process-pane-%0')).toBeInTheDocument();
  });
});
