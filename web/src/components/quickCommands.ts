// Quick command definitions and persistence for the terminal control panel.
//
// Presets are code-defined and never persisted. Only user-added commands are
// stored in localStorage, so changing the preset list in a future release
// never clobbers a user's saved commands.

export interface QuickCommand {
  /** Stable unique id (preset ids are fixed strings; user ids are timestamps). */
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

const STORAGE_KEY = 'nession_quick_commands';

/** Built-in commands. Order here is the order shown above user commands. */
export const PRESETS: QuickCommand[] = [
  { id: 'preset-clear', label: 'clear', command: 'clear' },
  { id: 'preset-ls', label: 'ls -la', command: 'ls -la' },
  { id: 'preset-git-status', label: 'git status', command: 'git status' },
  { id: 'preset-git-pull', label: 'git pull', command: 'git pull' },
  { id: 'preset-ctrl-c', label: 'Ctrl+C', command: '\x03', raw: true },
];

/** Read user-added commands from localStorage; returns [] on any failure. */
export function loadUserCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep only well-formed entries.
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

/** Persist user-added commands. Swallows quota/serialization errors. */
export function saveUserCommands(cmds: QuickCommand[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cmds));
  } catch {
    // Ignore — persistence is best-effort.
  }
}
