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
