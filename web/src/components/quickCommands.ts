// Quick command definitions for the terminal control panel.
//
// Presets are code-defined and never persisted. User-added commands are now
// stored on the server (issue #95, part 3) rather than browser localStorage,
// so they are shared across browsers and survive a client reset.
//
// The `LEGACY_STORAGE_KEY` helpers remain only to support a one-time migration
// of pre-existing localStorage commands into the server store.

export interface QuickCommand {
  /** Stable unique id (preset ids are fixed strings; user ids are server-assigned). */
  id: string;
  /** Button label shown in the panel. */
  label: string;
  /** Text sent to the terminal. */
  command: string;
  /**
   * When true, `command` is sent verbatim with no trailing carriage return —
   * used for control keys like Ctrl+C ("\x03"). When false/undefined, the
   * sender appends "\r" to execute the command.
   */
  raw?: boolean;
}

/** localStorage key used by the pre-server implementation. */
export const LEGACY_STORAGE_KEY = 'nession_quick_commands';

/** Built-in commands. Order here is the order shown above user commands. */
export const PRESETS: QuickCommand[] = [
  { id: 'preset-clear', label: 'clear', command: 'clear' },
  { id: 'preset-ls', label: 'ls -la', command: 'ls -la' },
  { id: 'preset-git-status', label: 'git status', command: 'git status' },
  { id: 'preset-git-pull', label: 'git pull', command: 'git pull' },
  { id: 'preset-ctrl-c', label: 'Ctrl+C', command: '\x03', raw: true },
];

/**
 * Mobile-only presets: keys that don't exist or are hard to reach on
 * virtual keyboards.  Shown only on touch devices above the regular
 * preset row so the most-tapped buttons are closest to the input area.
 */
export const MOBILE_PRESETS: QuickCommand[] = [
  { id: 'mobile-up',    label: '↑',    command: '\x1b[A', raw: true },
  { id: 'mobile-down',  label: '↓',    command: '\x1b[B', raw: true },
  { id: 'mobile-left',  label: '←',    command: '\x1b[D', raw: true },
  { id: 'mobile-right', label: '→',    command: '\x1b[C', raw: true },
  { id: 'mobile-tab',   label: 'Tab',  command: '\t',     raw: true },
  { id: 'mobile-esc',   label: 'Esc',  command: '\x1b',   raw: true },
  { id: 'mobile-ctrl-d',label: 'Ctrl+D', command: '\x04', raw: true },
  { id: 'mobile-ctrl-a',label: 'Ctrl+A', command: '\x01', raw: true },
  { id: 'mobile-ctrl-e',label: 'Ctrl+E', command: '\x05', raw: true },
];

/**
 * Read legacy user commands from localStorage; returns [] on any failure.
 * Used only for the one-time migration into the server store.
 */
export function loadLegacyCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {return [];}
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {return [];}
    return parsed.filter(
      (c): c is QuickCommand =>
        c &&
        typeof c.id === 'string' &&
        typeof c.label === 'string' &&
        typeof c.command === 'string',
    );
  } catch {
    return [];
  }
}

/** Clear the legacy localStorage entry after a successful migration. */
export function clearLegacyCommands(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore — best-effort.
  }
}
