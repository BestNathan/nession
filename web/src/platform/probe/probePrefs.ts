// Client probe settings (#4618).
//
// Owner-local localStorage persistence, the same pattern as `attachPrefs`:
// there is no global settings store. The periodic maintenance interval is
// configurable; `0` disables periodic probing without disabling event-driven
// recovery. Values are clamped to finite bounds on read so a corrupt or
// hostile stored value can never arm an unbounded timer.

import { clampProbeInterval, DEFAULT_PROBE_INTERVAL_MS } from './types';

const STORAGE_KEY = 'nession_probe_prefs';

export interface ProbePrefs {
  /** Periodic maintenance interval in ms. 0 disables the periodic timer. */
  intervalMs: number;
}

const DEFAULT_PREFS: ProbePrefs = { intervalMs: DEFAULT_PROBE_INTERVAL_MS };

/** Read probe prefs from localStorage, falling back to defaults. */
export function loadProbePrefs(): ProbePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_PREFS };
    }
    const parsed = JSON.parse(raw) as Partial<ProbePrefs>;
    const intervalMs = typeof parsed.intervalMs === 'number'
      ? clampProbeInterval(parsed.intervalMs)
      : DEFAULT_PROBE_INTERVAL_MS;
    return { intervalMs };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist probe prefs for next time. Failures are non-fatal. */
export function saveProbePrefs(prefs: ProbePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ intervalMs: clampProbeInterval(prefs.intervalMs) }));
  } catch {
    // Ignore quota / disabled-storage errors.
  }
}
