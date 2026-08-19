import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatRelativeTime, formatAbsoluteTime, getStatusVariant, formatSize, formatRelativeTimeSeconds } from '@/lib/format';

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows seconds ago for < 60 seconds', () => {
    const iso = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatRelativeTime(iso)).toBe('30s ago');
  });

  it('shows minutes ago for < 60 minutes', () => {
    const iso = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso)).toBe('45m ago');
  });

  it('shows hours ago for < 24 hours', () => {
    const iso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso)).toBe('12h ago');
  });

  it('shows days ago for >= 24 hours', () => {
    const iso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso)).toBe('5d ago');
  });

  it('shows 刚刚 for current time', () => {
    const iso = new Date().toISOString();
    expect(formatRelativeTime(iso)).toBe('刚刚');
  });
});

describe('formatAbsoluteTime', () => {
  it('formats ISO date to locale string', () => {
    const iso = '2026-07-15T12:00:00Z';
    const result = formatAbsoluteTime(iso);
    expect(result).toMatch(/2026/);
  });
});

describe('getStatusVariant', () => {
  it('returns default for online', () => {
    expect(getStatusVariant('online')).toBe('default');
  });

  it('returns secondary for degraded', () => {
    expect(getStatusVariant('degraded')).toBe('secondary');
  });

  it('returns outline for offline', () => {
    expect(getStatusVariant('offline')).toBe('outline');
  });
});

describe('formatSize', () => {
  it('returns empty string for 0 bytes', () => {
    expect(formatSize(0)).toBe('');
  });

  it('formats bytes', () => {
    expect(formatSize(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(2048)).toBe('2.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});

describe('formatRelativeTimeSeconds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows just now for < 1 minute', () => {
    expect(formatRelativeTimeSeconds(Math.floor(Date.now() / 1000) - 30)).toBe('just now');
  });

  it('shows minutes ago for < 60 minutes', () => {
    const ts = Math.floor(Date.now() / 1000) - 45 * 60;
    expect(formatRelativeTimeSeconds(ts)).toBe('45m ago');
  });

  it('shows hours ago for < 24 hours', () => {
    const ts = Math.floor(Date.now() / 1000) - 12 * 60 * 60;
    expect(formatRelativeTimeSeconds(ts)).toBe('12h ago');
  });

  it('shows days ago for >= 30 days', () => {
    const ts = Math.floor(Date.now() / 1000) - 35 * 24 * 60 * 60;
    expect(formatRelativeTimeSeconds(ts)).toMatch(/ago$/);
  });
});
