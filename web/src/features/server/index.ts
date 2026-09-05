import { ServerPlugin } from './ServerPlugin';
export { ServerPlugin } from './ServerPlugin';
export type { ServerInfo } from '@/types';

/** App-level singleton — one server binding per WebSocketService lifetime. */
export const serverApi = new ServerPlugin();
