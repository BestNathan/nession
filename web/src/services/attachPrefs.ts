import type { AttachMode, EnvFileRef } from '../types';

const STORAGE_KEY = 'nession_attach_prefs';

/** Persisted attach preferences, pre-filled into the attach dialog. */
export interface AttachPrefs {
  mode: AttachMode;
  envFiles: EnvFileRef[];
}

const DEFAULT_PREFS: AttachPrefs = { mode: 'auto', envFiles: [] };

function isAttachMode(v: unknown): v is AttachMode {
  return v === 'auto' || v === 'p2p' || v === 'relay';
}

/** Read last-used attach preferences from localStorage, falling back to defaults. */
export function loadAttachPrefs(): AttachPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_PREFS };
    }
    const parsed = JSON.parse(raw) as Partial<AttachPrefs>;
    return {
      mode: isAttachMode(parsed.mode) ? parsed.mode : 'auto',
      envFiles: Array.isArray(parsed.envFiles) ? parsed.envFiles : [],
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist attach preferences for next time. Failures are non-fatal. */
export function saveAttachPrefs(prefs: AttachPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore quota / disabled-storage errors.
  }
}
