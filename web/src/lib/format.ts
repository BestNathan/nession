import type { Agent } from '../types';

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

/** Format agent uptime from registered_at ISO timestamp. */
export function formatUptime(registeredAtIso: string | undefined): string {
  if (!registeredAtIso) {return '';}
  const diff = Date.now() - new Date(registeredAtIso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {return `${seconds}s`;}
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {return `${minutes}m`;}
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {return `${hours}h`;}
  return `${Math.floor(hours / 24)}d`;
}

/** Resolve the effective display name for an agent. */
export function agentDisplayName(agent: { display_name?: string; hostname: string }): string {
  return agent.display_name || agent.hostname;
}
