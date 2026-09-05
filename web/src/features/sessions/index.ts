import { SessionsPlugin } from './SessionsPlugin';
export { SessionsPlugin } from './SessionsPlugin';
export type {
  AttachInfo,
  CreateSessionResponse,
  EnvFileRef,
  KillSessionResponse,
  Session,
  SessionsListResponse,
} from './types';

/** App-level singleton — one sessions binding per WebSocketService lifetime. */
export const sessionsApi = new SessionsPlugin();
