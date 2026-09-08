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
