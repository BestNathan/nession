// Shared public formatting. An unknown measurement is N/A, never zero.
export function fmt(n: unknown): string {
  if (n === null || n === undefined || typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  return Intl.NumberFormat('en-US', {
    notation: Math.abs(n) > 9999 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(n);
}

export function pct(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) + '%' : 'N/A';
}

export function duration(ms: unknown): string {
  if (ms === null || ms === undefined || typeof ms !== 'number' || !Number.isFinite(ms)) return 'N/A';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's';
  return (ms / 60000).toFixed(1).replace(/\.0$/, '') + 'm';
}

export function date(value: unknown): string {
  if (!value || typeof value !== 'string' || Number.isNaN(Date.parse(value))) return 'Unavailable';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function utcStamp(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function utcDateTime(value: string): string {
  return new Date(value).toLocaleString('en-US', {timeZone: 'UTC'}) + ' UTC';
}
