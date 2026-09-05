/**
 * Env wire response types. Defined today in `components/env/types.ts` and
 * re-exported by `web/src/types.ts` (shared with the legacy facade); this
 * module is the feature's stable import point.
 */
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
} from '@/types';
