import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatRelativeTime } from '../format';

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

  it('shows 0s ago for current time', () => {
    const iso = new Date().toISOString();
    expect(formatRelativeTime(iso)).toBe('0s ago');
  });
});
