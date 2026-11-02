import { describe, expect, it } from 'vitest';
import type {
  DiscoveredProcess,
  PaneProcessSnapshot,
  ProcessMetric,
} from '@/product/agent/types';
import {
  aggregateMetric,
  buildProcessForest,
  buildProcessTree,
  collectDescendants,
  displayAggregate,
  displayCommand,
  displayMetric,
  formatElapsed,
  sessionDiscovery,
  sessionProcesses,
} from '@/product/agent/model/processSnapshot';

function metric(value: number | null, state: ProcessMetric['state'] = 'sampled'): ProcessMetric {
  return { value: value ?? undefined, state, reason: state === 'sampled' ? undefined : 'reason' };
}

function process(pid: number, parent: number | null, overrides: Partial<DiscoveredProcess> = {}): DiscoveredProcess {
  return {
    pid,
    parent_pid: parent,
    start_time_ms: 1_000,
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

function pane(
  overrides: Partial<PaneProcessSnapshot> & Pick<PaneProcessSnapshot, 'pane_id'>,
): PaneProcessSnapshot {
  return {
    session_ids: ['$0'],
    session_names: ['s1'],
    window_id: '@0',
    window_index: 0,
    window_name: 'shell',
    pane_index: 0,
    pane_pid: 10,
    pane_tty: '/dev/pts/1',
    method: 'process_tree',
    coverage: 'partial',
    reason_codes: [],
    processes: [],
    ...overrides,
  };
}

describe('process snapshot model', () => {
  it('builds a PPID tree with roots for processes whose parent is outside the Pane', () => {
    const tree = buildProcessTree([
      process(10, 1),
      process(11, 10),
      process(12, 11),
      process(20, 999),
    ]);
    expect(tree.map((node) => node.process.pid)).toEqual([10, 20]);
    expect(tree[0].children[0].process.pid).toBe(11);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].process.pid).toBe(12);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it('walks PPID descendants only for the selected process', () => {
    // A worker that was reparented away from the pane shell is in the Pane
    // (cgroup membership) but must not be merged into another PID's ancestry.
    const pane = [
      process(10, 1),
      process(11, 10),
      process(12, 1, { command: 'worker.py' }),
    ];
    expect(collectDescendants(pane[0], pane).map((entry) => entry.pid)).toEqual([10, 11]);
    expect(collectDescendants(pane[2], pane).map((entry) => entry.pid)).toEqual([12]);
  });

  it('sums sampled metrics and keeps a valid CPU value above 100%', () => {
    const processes = [
      process(10, 1, { cpu_percent: metric(120.5) }),
      process(11, 10, { cpu_percent: metric(80) }),
    ];
    const aggregate = aggregateMetric(processes, (entry) => entry.cpu_percent);
    expect(aggregate.state).toBe('sampled');
    expect(displayAggregate(aggregate, '%').text).toBe('200.5%');
  });

  it('never turns a missing member metric into a zero contribution', () => {
    const processes = [
      process(10, 1),
      process(11, 10, { io_read_kib_per_s: metric(null, 'denied') }),
    ];
    const aggregate = aggregateMetric(processes, (entry) => entry.io_read_kib_per_s);
    expect(aggregate.state).toBe('denied');
    expect(aggregate.value).toBeUndefined();
    expect(displayAggregate(aggregate, ' KiB/s')).toMatchObject({
      text: 'Unavailable',
      unavailable: true,
    });
  });

  it('shows a sampled zero as a value and an unavailable metric as a state', () => {
    expect(displayMetric(metric(0), '%').text).toBe('0.0%');
    expect(displayMetric(metric(null, 'unsupported'), '', 0)).toMatchObject({
      text: 'Unavailable',
      unavailable: true,
      detail: 'unsupported: reason',
    });
  });

  it('falls back to the executable when the command was denied', () => {
    const denied = process(10, 1, {
      command: '',
      command_state: 'denied',
      command_reason: 'command_unreadable',
      executable: '/usr/bin/tool',
    });
    expect(displayCommand(denied)).toBe('/usr/bin/tool');
  });

  it('formats lifetimes without inventing a sum', () => {
    expect(formatElapsed(500)).toBe('<1s');
    expect(formatElapsed(12_000)).toBe('12s');
    expect(formatElapsed(125_000)).toBe('2m 5s');
    expect(formatElapsed(3_600_000)).toBe('1h');
  });

  it('deduplicates linked Pane membership by process identity, not by PID alone', () => {
    const shared = [process(10, 1), process(11, 10)];
    const panes = [
      pane({ pane_id: '%0', processes: shared }),
      pane({ pane_id: '%1', processes: [process(10, 1), process(11, 10)] }),
      pane({
        pane_id: '%2',
        processes: [process(10, 1, { start_time_ms: 2_000 })],
      }),
    ];
    expect(sessionProcesses(panes).map((entry) => `${entry.pid}:${entry.start_time_ms}`)).toEqual([
      '10:1000',
      '10:2000',
      '11:1000',
    ]);
  });

  it('builds one Session forest with real PPID edges and separate roots', () => {
    const forest = buildProcessForest([
      pane({
        pane_id: '%0',
        processes: [
          process(10, 1),
          process(11, 10),
          process(12, 1, { command: 'worker.py' }),
        ],
      }),
      pane({
        pane_id: '%1',
        processes: [
          process(10, 1),
          process(11, 10),
          process(13, 10, { command: 'sleep 30' }),
        ],
      }),
    ]);

    expect(forest.map((node) => node.process.pid)).toEqual([10, 12]);
    expect(forest[0].children.map((node) => node.process.pid)).toEqual([11, 13]);
    // A reparented worker is its own root; it is never folded into another PID.
    expect(forest[1].children).toEqual([]);
  });

  it('states Session coverage from every observed Pane', () => {
    const complete = sessionDiscovery({
      session_name: 's1',
      snapshot_at_ms: 1,
      platform: 'linux',
      methods: ['cgroup', 'process_tree'],
      panes: [pane({ pane_id: '%0', coverage: 'complete' })],
      truncated: false,
      limits: { max_processes: 512, max_depth: 32, cpu_window_ms: 150 },
    });
    expect(complete).toEqual({
      methods: ['cgroup', 'process_tree'],
      coverage: 'complete',
      reasonCodes: [],
    });

    const mixed = sessionDiscovery({
      session_name: 's1',
      snapshot_at_ms: 1,
      platform: 'linux',
      methods: ['process_tree'],
      panes: [
        pane({ pane_id: '%0', coverage: 'complete', reason_codes: ['process_outside_cgroup'] }),
        pane({ pane_id: '%1', coverage: 'partial', reason_codes: ['sid_tty_association'] }),
        pane({ pane_id: '%2', coverage: 'partial', reason_codes: ['sid_tty_association'] }),
      ],
      truncated: false,
      limits: { max_processes: 512, max_depth: 32, cpu_window_ms: 150 },
    });
    expect(mixed.coverage).toBe('partial');
    expect(mixed.reasonCodes).toEqual(['process_outside_cgroup', 'sid_tty_association']);

    const unavailable = sessionDiscovery({
      session_name: 's1',
      snapshot_at_ms: 1,
      platform: 'linux',
      methods: [],
      panes: [pane({ pane_id: '%0', coverage: 'unavailable' })],
      truncated: false,
      limits: { max_processes: 512, max_depth: 32, cpu_window_ms: 150 },
    });
    expect(unavailable.coverage).toBe('unavailable');
    expect(unavailable.methods).toEqual(['unavailable']);
  });
});
