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

/**
 * Filter / sort vocabulary for the session list. Declared here so both the
 * search UI (feature) and the app-layer composers (useDashboardFilter) can
 * share it without a feature->app import.
 */
export type StatusFilter = 'all' | 'online' | 'offline' | 'degraded';
export type SortField = 'name' | 'activity';
export type SortDirection = 'asc' | 'desc';
