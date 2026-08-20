import { describe, it, expect } from 'vitest';
import { isDaytime, githubThemeForDate } from '@/hooks/useScheduledGithubTheme';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';

describe('useScheduledGithubTheme helpers', () => {
  it('treats 06:00–17:59 as daytime', () => {
    expect(isDaytime(new Date('2026-01-01T06:00:00'))).toBe(true);
    expect(isDaytime(new Date('2026-01-01T12:00:00'))).toBe(true);
    expect(isDaytime(new Date('2026-01-01T17:59:00'))).toBe(true);
  });

  it('treats 18:00–05:59 as nighttime', () => {
    expect(isDaytime(new Date('2026-01-01T18:00:00'))).toBe(false);
    expect(isDaytime(new Date('2026-01-01T23:00:00'))).toBe(false);
    expect(isDaytime(new Date('2026-01-01T05:59:00'))).toBe(false);
  });

  it('selects githubLight during day and githubDark at night', () => {
    expect(githubThemeForDate(new Date('2026-01-01T10:00:00'))).toBe(githubLight);
    expect(githubThemeForDate(new Date('2026-01-01T22:00:00'))).toBe(githubDark);
  });
});
