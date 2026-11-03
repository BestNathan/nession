export type EnvSource = 'server' | 'agent';

export interface EnvFileInfo {
  name: string;
  source: EnvSource;
  agent_id?: string;
  size: number;
  modified: number;
  var_count: number;
}

export interface EnvFileRef {
  name: string;
  source: EnvSource;
  agent_id?: string;
}

export interface EnvListResponse {
  files: EnvFileInfo[];
  error?: string;
}

export interface EnvGetResponse {
  success: boolean;
  content?: string;
  in_use_by?: string[];
  error?: string;
}

export interface EnvWriteResponse {
  success: boolean;
  exists?: boolean;
  error?: string;
  warnings?: string[];
  in_use_by?: string[];
  re_sourced?: string[];
  re_source_errors?: string[];
}

export interface EnvDeleteResponse {
  success: boolean;
  error?: string;
}

export interface ActiveEnvFile {
  name: string;
  source: EnvSource;
  agent_id?: string;
  phase: string;
}

export interface SessionEnvActiveResponse {
  active: ActiveEnvFile[];
}

export interface SessionEnvResponse {
  success: boolean;
  error?: string;
  warnings?: string[];
}

export interface SessionEnvQueryResponse {
  sourced_files: EnvFileRef[];
  error?: string;
}

/**
 * The observed half of a Session Environment Binding (#170). Values are never
 * on this wire: only the keys the binding manages and how far convergence got.
 */
export interface SessionEnvObservedState {
  applied_revision: number;
  /** in_sync | applying | pending_shell | unsupported_shell | error */
  status: string;
  profiles: EnvFileRef[];
  managed_keys: string[];
  shell?: string | null;
  shell_revision?: number | null;
  last_error?: string | null;
}

export interface SessionEnvBindingProfileState {
  profile: EnvFileRef;
  phase: string;
  content_hash?: string | null;
  /** The file changed since the Session materialized this revision. */
  outdated: boolean;
}

export interface SessionEnvBindingState {
  session_id: string;
  desired_revision: number;
  desired_profiles: SessionEnvBindingProfileState[];
  observed?: SessionEnvObservedState | null;
  error?: string | null;
}

export interface SessionEnvBindingResponse {
  success: boolean;
  binding?: SessionEnvBindingState | null;
  warnings: string[];
  error?: string | null;
}
