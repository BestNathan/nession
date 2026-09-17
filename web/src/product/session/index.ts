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
export {
  mapDomainState,
  type AgentChannel,
  type AttachmentChannel,
  type ChannelView,
  type DomainState,
  type MapDomainStateInput,
  type SessionChannel,
} from './model/domainState';

/** App-level singleton — one sessions binding per WebSocketService lifetime. */
export const sessionsApi = new SessionsPlugin();
