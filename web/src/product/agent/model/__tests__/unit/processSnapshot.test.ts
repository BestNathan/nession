import { describe, expect, it } from 'vitest';
import type { DiscoveredProcess, ProcessMetric } from '@/product/agent/types';
import {
  aggregateMetric,
  buildProcessTree,
  collectDescendants,
  displayAggregate,
  displayCommand,
  displayMetric,
  formatElapsed,
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
});
