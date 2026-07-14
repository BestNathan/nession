import type { AttachMode } from '../types';

const STORAGE_KEY = 'nession_attach_prefs';

export type RendererType = 'webgl' | 'canvas';

export interface AttachPrefs {
  mode: AttachMode;
  renderer: RendererType;
}

const DEFAULT_PREFS: AttachPrefs = { mode: 'auto', renderer: 'webgl' };

function isAttachMode(v: unknown): v is AttachMode {
  return v === 'auto' || v === 'p2p' || v === 'relay';
}

function isRenderer(v: unknown): v is RendererType {
  return v === 'webgl' || v === 'canvas';
}

/** Read last-used attach prefs from localStorage, falling back to defaults. */
export function loadAttachPrefs(): AttachPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_PREFS };
    }
    const parsed = JSON.parse(raw) as Partial<AttachPrefs>;
    return {
      mode: isAttachMode(parsed.mode) ? parsed.mode : 'auto',
      renderer: isRenderer(parsed.renderer) ? parsed.renderer : 'webgl',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist attach prefs for next time. Failures are non-fatal. */
export function saveAttachPrefs(prefs: AttachPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore quota / disabled-storage errors.
  }
}
