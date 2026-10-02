import type { Agent } from '@/types';

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor(diff / 1000));
  if (seconds < 1) {
    return '刚刚';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * A transcript record's own timestamp, as a clock time (#1120).
 *
 * Short on purpose: the reading order is the transcript's order, so the time is
 * orientation rather than information. Anything unparseable is dropped rather
 * than shown raw — an RFC 3339 string in the middle of a sentence is worse than
 * no time at all.
 *
 * Lives here rather than with the transcript that used to own it, because
 * `#1363` moved the transcript into the shared layer and a provider must not
 * carry a formatter the shared renderer cannot reach. `capabilities/claude-code`
 * keeps its `clockTime` name as a delegation, so the two can never disagree
 * about what `10:06` means.
 */
export function formatClockTime(timestamp: string | null | undefined): string | null {
  if (!timestamp) {
    return null;
  }
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function getStatusVariant(status: Agent['status']): 'default' | 'secondary' | 'outline' {
  switch (status) {
    case 'online':
      return 'default';
    case 'degraded':
      return 'secondary';
    case 'offline':
      return 'outline';
  }
}

export function formatSize(bytes: number): string {
  if (bytes === 0) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatRelativeTimeSeconds(ts: number): string {
  if (!ts) {
    return '';
  }
  const now = Date.now();
  const diff = now - ts * 1000;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * How long a turn's work took, for the turn's process control.
 *
 * Coarse on purpose. The line answers "was that quick, or did it grind?", and a
 * transcript of `12.4s` answers that no better than `12s` while reading as a
 * measurement nobody asked for. Sub-second rounds up rather than down: work that
 * happened is not `0s`.
 */
export function formatWorkDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
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
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Resolve the effective display name for an agent. */
export function agentDisplayName(agent: { display_name?: string; hostname: string }): string {
  return agent.display_name || agent.hostname;
}
