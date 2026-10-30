import type {
  DiscoveredProcess,
  PaneProcessSnapshot,
  ProcessCoverage,
  ProcessDiscoveryMethod,
  ProcessMetric,
  ProcessMetricState,
} from '@/generated/protocol/core/server-session-processes/v1';

/**
 * Pure process-snapshot model helpers (#2514).
 *
 * The backend ships a flat process list with parent edges. Tree shape and
 * resource aggregation are presentation decisions, so they live here where
 * they can be tested without a socket or a DOM.
 */

export interface ProcessTreeNode {
  process: DiscoveredProcess;
  depth: number;
  children: ProcessTreeNode[];
}

export interface AggregateMetric {
  state: ProcessMetricState | 'unavailable';
  value?: number;
  reason?: string;
}

/** Identity is PID plus start time; a reused PID is a different process. */
export function processKey(process: DiscoveredProcess): string {
  return `${process.pid}:${process.start_time_ms ?? 'unknown'}`;
}

/** A present optional value, without loosening equality elsewhere. */
export function isSet<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** The command a row shows. A denied command is not an empty one. */
export function displayCommand(process: DiscoveredProcess): string {
  if (process.command.trim().length > 0) {
    return process.command;
  }
  if (process.executable.trim().length > 0 && process.executable !== '[unknown]') {
    return process.executable;
  }
  return `PID ${process.pid}`;
}

/** Build the PPID tree inside one Pane, roots first, children by PID. */
export function buildProcessTree(processes: DiscoveredProcess[]): ProcessTreeNode[] {
  const byPid = new Map<number, DiscoveredProcess>();
  for (const process of processes) {
    if (!byPid.has(process.pid)) {
      byPid.set(process.pid, process);
    }
  }

  const childrenOf = new Map<number, DiscoveredProcess[]>();
  const roots: DiscoveredProcess[] = [];
  for (const process of byPid.values()) {
    const parent =
      isSet(process.parent_pid) && process.parent_pid !== process.pid
        ? byPid.get(process.parent_pid)
        : undefined;
    if (parent) {
      const siblings = childrenOf.get(parent.pid) ?? [];
      siblings.push(process);
      childrenOf.set(parent.pid, siblings);
    } else {
      // A process whose parent is outside the Pane (or reparented to init) is
      // a root here. It is not attached to an arbitrary visible process.
      roots.push(process);
    }
  }

  const seen = new Set<number>();
  const build = (process: DiscoveredProcess, depth: number): ProcessTreeNode => {
    seen.add(process.pid);
    const children = (childrenOf.get(process.pid) ?? [])
      .sort((a, b) => a.pid - b.pid)
      // A malformed/duplicated edge must not recurse forever.
      .filter((child) => !seen.has(child.pid))
      .map((child) => build(child, depth + 1));
    return { process, depth, children };
  };

  return roots.sort((a, b) => a.pid - b.pid).map((root) => build(root, 0));
}

/**
 * The selected process plus its PPID descendants inside the same Pane.
 *
 * This walks parent edges only. A cgroup-only reparented worker is not part of
 * the selected PID's ancestry and is deliberately not merged in, even though
 * it is present in the Pane.
 */
export function collectDescendants(
  selected: DiscoveredProcess,
  processes: DiscoveredProcess[],
): DiscoveredProcess[] {
  const childrenOf = new Map<number, DiscoveredProcess[]>();
  const byKey = new Map<string, DiscoveredProcess>();
  for (const process of processes) {
    byKey.set(processKey(process), process);
    if (isSet(process.parent_pid)) {
      const siblings = childrenOf.get(process.parent_pid) ?? [];
      siblings.push(process);
      childrenOf.set(process.parent_pid, siblings);
    }
  }
  if (!byKey.has(processKey(selected))) {
    byKey.set(processKey(selected), selected);
  }

  const result: DiscoveredProcess[] = [];
  const seen = new Set<string>();
  const queue: DiscoveredProcess[] = [selected];
  while (queue.length > 0) {
    const current = queue.shift() as DiscoveredProcess;
    const key = processKey(current);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(current);
    for (const child of childrenOf.get(current.pid) ?? []) {
      if (!seen.has(processKey(child))) {
        queue.push(child);
      }
    }
  }
  return result;
}

/**
 * Sum one metric over a set of processes.
 *
 * Missing values never become zero: one unsupported/denied/stale member makes
 * the aggregate unavailable, with the first missing member's reason and state.
 */
export function aggregateMetric(
  processes: DiscoveredProcess[],
  metricOf: (process: DiscoveredProcess) => ProcessMetric,
): AggregateMetric {
  if (processes.length === 0) {
    return { state: 'unavailable', reason: 'empty_scope' };
  }
  let sum = 0;
  for (const process of processes) {
    const metric = metricOf(process);
    if (metric.state !== 'sampled' || !isSet(metric.value)) {
      return {
        state: metric.state === 'sampled' ? 'unavailable' : metric.state,
        reason: metric.reason ?? 'subtree_incomplete',
      };
    }
    sum += metric.value;
  }
  return { state: 'sampled', value: sum };
}

export interface DisplayMetric {
  text: string;
  unavailable: boolean;
  detail?: string;
}

/** Format one metric with its unit, or say why there is no value. */
export function displayMetric(
  metric: ProcessMetric,
  unit: string,
  digits = 1,
): DisplayMetric {
  if (metric.state === 'sampled' && isSet(metric.value)) {
    const rounded =
      digits === 0 ? Math.round(metric.value).toString() : metric.value.toFixed(digits);
    return { text: `${rounded}${unit}`, unavailable: false };
  }
  return {
    text: 'Unavailable',
    unavailable: true,
    detail: metric.reason ? `${metric.state}: ${metric.reason}` : metric.state,
  };
}

export function displayAggregate(metric: AggregateMetric, unit: string, digits = 1): DisplayMetric {
  if (metric.state === 'sampled' && isSet(metric.value)) {
    const rounded =
      digits === 0 ? Math.round(metric.value).toString() : metric.value.toFixed(digits);
    return { text: `${rounded}${unit}`, unavailable: false };
  }
  return {
    text: 'Unavailable',
    unavailable: true,
    detail: metric.reason ? `${metric.state}: ${metric.reason}` : metric.state,
  };
}

/** Human lifetime. Elapsed is a point-in-time value, never summed. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 1) {
    return '<1s';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

const METHOD_LABELS: Record<ProcessDiscoveryMethod, string> = {
  cgroup: 'Dedicated cgroup',
  process_tree: 'Process tree',
  unavailable: 'Unavailable',
};

const COVERAGE_LABELS: Record<ProcessCoverage, string> = {
  complete: 'Complete',
  partial: 'Partial',
  unavailable: 'Unavailable',
};

const REASON_LABELS: Record<string, string> = {
  no_dedicated_cgroup: 'No verified per-pane cgroup; using the process tree.',
  platform_without_dedicated_cgroup: 'This platform has no per-pane cgroup; using the process tree.',
  cgroup_unavailable: 'The cgroup filesystem is not available; using the process tree.',
  cgroup_unreadable: 'The cgroup could not be read; using the process tree.',
  cgroup_v1_unsupported: 'cgroup v1 is not supported for dedicated-scope discovery; using the process tree.',
  shared_cgroup: 'The cgroup is shared, not dedicated to this pane; using the process tree.',
  cgroup_pane_pid_missing: 'The cgroup does not contain the pane root; using the process tree.',
  pane_process_missing: "The pane's root process is missing, so membership cannot be established.",
  process_table_unavailable: 'The process table could not be read on this Agent.',
  process_limit_reached: 'The snapshot hit a process or depth bound.',
  process_outside_cgroup: 'A descendant left the dedicated cgroup; membership is partial.',
  sid_tty_association: 'SID/TTY association is lower-confidence evidence, not proof of membership.',
};

export function methodLabel(method: ProcessDiscoveryMethod): string {
  return METHOD_LABELS[method] ?? method;
}

export function coverageLabel(coverage: ProcessCoverage): string {
  return COVERAGE_LABELS[coverage] ?? coverage;
}

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

export function paneTitle(pane: PaneProcessSnapshot): string {
  const window = `Window ${pane.window_index} · ${pane.window_name || 'unnamed'}`;
  return `${window} · Pane ${pane.pane_index}`;
}

/** `HH:MM:SS` in the viewer's locale, with the date when it is not today. */
export function formatSnapshotTime(epochMs: number): string {
  const date = new Date(epochMs);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
}
