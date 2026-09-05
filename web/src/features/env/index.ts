import { EnvPlugin } from './EnvPlugin';
export { EnvPlugin } from './EnvPlugin';
export type {
  ActiveEnvFile,
  EnvDeleteResponse,
  EnvFileInfo,
  EnvFileRef,
  EnvGetResponse,
  EnvListResponse,
  EnvSource,
  EnvWriteResponse,
  SessionEnvActiveResponse,
  SessionEnvQueryResponse,
  SessionEnvResponse,
} from './types';

/** App-level singleton — one env binding per WebSocketService lifetime. */
export const envApi = new EnvPlugin();
