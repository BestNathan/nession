import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '@/types';
import type { DiscoveredProcess, ProcessMetric, ProcessSnapshot } from '@/product/agent/types';
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
  session_count: 2,
  last_heartbeat: '2026-01-01T00:00:00Z',
  metadata: {
    tmux_version: '3.4',
    os_version: 'linux',
    nession_version: '0.35.0',
    image_tag: 'ghcr.io/nession/agent:dev',
  },
  protocols: {
    provider: 'a1',
    protocols: { 'agent.attach': { versions: [1] } },
  },
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

const shell = process(10, 1, { command: 'bash -l --token [REDACTED]', redacted: true });
const child = process(11, 10, {
  command: 'sleep 30',
  cpu_percent: metric(20),
  io_read_kib_per_s: metric(null, 'unsupported'),
});
const worker = process(12, 1, { command: 'worker.py' });

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
      processes: [shell, child, worker],
    },
    {
      session_ids: ['$1'],
      session_names: ['s1', 'linked'],
      window_id: '@1',
      window_index: 1,
      window_name: 'shared',
      pane_id: '%1',
      pane_index: 0,
      pane_pid: 10,
      pane_tty: '/dev/pts/1',
      method: 'process_tree',
      coverage: 'partial',
      reason_codes: ['no_dedicated_cgroup', 'sid_tty_association'],
      processes: [shell, child],
    },
  ],
  truncated: false,
  limits: { max_processes: 512, max_depth: 32, cpu_window_ms: 150 },
};

function stubMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function clickSummary(testId: string) {
  const summary = within(screen.getByTestId(testId)).getByText(
    testId === 'agent-details' ? 'Agent details' : 'Process details',
  );
  fireEvent.click(summary);
  return screen.getByTestId(testId) as HTMLDetailsElement;
}

describe('Agent Processes workspace', () => {
  beforeEach(() => {
    api.fetchProcessSnapshot.mockReset().mockResolvedValue(snapshot);
    api.connectionRevision.mockReset().mockReturnValue(1);
    api.onConnectionChange.mockClear();
    api.state.listener = null;
    stubMedia(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('observes only the current Session and renders one deduplicated forest', async () => {
    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);

    expect(await screen.findByTestId('process-forest')).toBeInTheDocument();
    expect(api.fetchProcessSnapshot).toHaveBeenCalledWith('a1:s1');
    expect(screen.queryByTestId('agent-process-session-selector')).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid^="process-pane-"]')).toBeNull();
    expect(screen.getByTestId('agent-process-session')).toHaveTextContent('s1');
    expect(screen.getAllByText('bash -l --token [REDACTED]')).toHaveLength(1);
    expect(screen.getByText('worker.py')).toBeInTheDocument();
  });

  it('does not fetch or choose a Session when the Workspace has none', async () => {
    api.fetchProcessSnapshot.mockClear();
    render(<AgentDetail agent={agent} state={state} />);

    expect(await screen.findByTestId('agent-processes-no-session')).toBeInTheDocument();
    expect(api.fetchProcessSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByTestId('process-forest')).not.toBeInTheDocument();
  });

  it('keeps Agent details closed by default and groups the facts when opened', async () => {
    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);

    const details = screen.getByTestId('agent-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const opened = clickSummary('agent-details');
    expect(opened.open).toBe(true);

    const content = within(screen.getByTestId('agent-details-content'));
    expect(content.getByText('Identity & connection')).toBeInTheDocument();
    expect(content.getByText('Runtime environment')).toBeInTheDocument();
    expect(content.getByText('Capability & discovery')).toBeInTheDocument();
    expect(content.getByText('a1')).toBeInTheDocument();
    expect(content.getByText('10.0.0.1:19091')).toBeInTheDocument();
    expect(content.getByText('3.4')).toBeInTheDocument();
    expect(content.getByText('Available (v1)')).toBeInTheDocument();
    await waitFor(() =>
      expect(content.getAllByText('Process tree').length).toBeGreaterThan(0),
    );
  });

  it('keeps Process details closed, persists it across scope, and resets on another PID', async () => {
    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);
    fireEvent.click(await screen.findByText('bash -l --token [REDACTED]'));

    expect((screen.getByTestId('process-details') as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(within(screen.getByTestId('process-details')).getByText('Process details'));
    expect((screen.getByTestId('process-details') as HTMLDetailsElement).open).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'With descendants' }));
    expect((screen.getByTestId('process-details') as HTMLDetailsElement).open).toBe(true);

    fireEvent.click(screen.getByText('sleep 30'));
    expect((screen.getByTestId('process-details') as HTMLDetailsElement).open).toBe(false);
  });

  it('aggregates PPID descendants and refuses to total a missing metric', async () => {
    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);
    fireEvent.click(await screen.findByText('bash -l --token [REDACTED]'));

    fireEvent.click(screen.getByRole('button', { name: 'With descendants' }));

    expect(within(screen.getByTestId('process-metric-cpu')).getByText('30.0%')).toBeInTheDocument();
    expect(within(screen.getByTestId('process-metric-read')).getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/2 processes · includes PID 10/)).toBeInTheDocument();
  });

  it('copies only the sanitized display string', async () => {
    // The shared clipboard owner takes the async branch only on secure origins.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);
    fireEvent.click(await screen.findByText('bash -l --token [REDACTED]'));
    fireEvent.click(screen.getByRole('button', { name: /Copy command/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('bash -l --token [REDACTED]'),
    );
    Reflect.deleteProperty(window, 'isSecureContext');
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('never labels another Session with the previous snapshot', async () => {
    const { rerender } = render(
      <AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />,
    );
    await screen.findByTestId('process-forest');

    rerender(
      <AgentDetail
        agent={{ ...agent, status: 'offline' }}
        state={state}
        currentSessionId="a1:s2"
      />,
    );

    await screen.findByTestId('agent-processes-offline');
    expect(screen.getByTestId('agent-process-session')).toHaveTextContent('s2');
    expect(screen.queryByTestId('process-forest')).not.toBeInTheDocument();
  });

  it('does not pretend an offline Agent answered', async () => {
    api.fetchProcessSnapshot.mockClear();
    render(<AgentDetail agent={{ ...agent, status: 'offline' }} state={state} currentSessionId="a1:s1" />);

    expect(await screen.findByTestId('agent-processes-offline')).toBeInTheDocument();
    expect(api.fetchProcessSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the last snapshot and marks it stale when a refresh fails', async () => {
    api.fetchProcessSnapshot
      .mockReset()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error('agent timed out'));

    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);
    await screen.findByTestId('process-forest');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh process snapshot' }));

    const error = await screen.findByTestId('agent-processes-error');
    expect(error).toHaveTextContent('agent timed out');
    expect(error).toHaveTextContent('Showing the last snapshot');
    expect(screen.getByTestId('process-forest')).toBeInTheDocument();
  });

  it('re-asks the Agent after the transport is replaced', async () => {
    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);
    await screen.findByTestId('process-forest');
    expect(api.fetchProcessSnapshot).toHaveBeenCalledTimes(1);

    api.connectionRevision.mockReturnValue(2);
    act(() => {
      api.state.listener?.();
    });

    await waitFor(() => expect(api.fetchProcessSnapshot).toHaveBeenCalledTimes(2));
    expect(api.state.listener).not.toBeNull();
  });

  it('moves focus into the App/narrow detail and back to the selected row', async () => {
    stubMedia(false);
    render(<AgentDetail agent={agent} state={state} currentSessionId="a1:s1" />);
    const row = await screen.findByText('bash -l --token [REDACTED]');

    const rowButton = row.closest('button');
    fireEvent.click(row);
    const inspector = screen.getByTestId('process-inspector');
    await waitFor(() => expect(document.activeElement).toBe(inspector.parentElement));

    fireEvent.click(screen.getByRole('button', { name: 'Back to processes' }));
    expect(screen.queryByTestId('process-inspector')).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(rowButton));
  });
});
