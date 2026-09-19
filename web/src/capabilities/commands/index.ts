import { CommandsPlugin } from './CommandsPlugin';
export { CommandsPlugin } from './CommandsPlugin';
export type {
  CommandsAddResponse,
  CommandsListResponse,
  CommandsRemoveResponse,
  CommandsUpdateResponse,
  QuickCommandItem,
} from './types';

/** App-level singleton — one commands binding per WebSocketService lifetime. */
export const commandsApi = new CommandsPlugin();

// The capsule composes these: `PRESETS` are the code-defined quick commands,
// `useQuickCommands` is the capability's own hook over them. Both are public
// API rather than internals — see `capabilities/files/index.ts` for the note
// (#801 acceptance criterion: capability cross-import goes through an explicit
// public API, not an arbitrary deep import).
export { PRESETS } from './quickCommands';
export type { QuickCommand } from './quickCommands';
export { useQuickCommands } from './hooks/useQuickCommands';
