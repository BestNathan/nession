/**
 * Sessions wire response types. Defined in `web/src/types.ts` today (shared
 * with the legacy facade); this module is the feature's stable import point,
 * re-exported so consumers never reach into the shared barrel for these.
 */
export type {
  AttachInfo,
  CreateSessionResponse,
  EnvFileRef,
  KillSessionResponse,
  Session,
  SessionsListResponse,
} from '@/types';
