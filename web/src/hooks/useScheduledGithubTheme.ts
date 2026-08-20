import { useEffect, useState } from 'react';
import type { Extension } from '@codemirror/state';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';

/** 06:00–17:59 local → light; 18:00–05:59 → dark. */
export function isDaytime(date: Date): boolean {
  const hour = date.getHours();
  return hour >= 6 && hour < 18;
}

export function githubThemeForDate(date: Date): Extension {
  return isDaytime(date) ? githubLight : githubDark;
}

/** GitHub theme following local clock: light 6am–6pm, dark otherwise. */
export function useScheduledGithubTheme(): Extension {
  const [theme, setTheme] = useState(() => githubThemeForDate(new Date()));

  useEffect(() => {
    const tick = () => setTheme(githubThemeForDate(new Date()));
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);

  return theme;
}
