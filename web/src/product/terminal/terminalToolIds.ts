/**
 * Stable ids for the two explicit views of the terminal-tools slot (#2710).
 *
 * Kept in their own module so the two capability definitions can name each
 * other as view companions without a cycle: Keys -> Commands and Commands ->
 * Keys are one declared relationship, not a dependency chain.
 */
export const TERMINAL_KEYS_ID = 'terminal-keys';
export const QUICK_COMMANDS_ID = 'quick-commands';
