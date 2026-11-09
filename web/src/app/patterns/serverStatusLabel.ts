import type { ConnectionState } from '@/platform/socket/types';

/** The one human wording for the passive Server connection signal. */
export const SERVER_LABEL: Record<ConnectionState, string> = {
  connected: 'Server connected',
  connecting: 'Server connecting',
  reconnecting: 'Server reconnecting',
  disconnected: 'Server disconnected',
};
