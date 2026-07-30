export interface ConfigFile {
  path: string;
  size: number;
  content_type: 'json' | 'markdown' | 'jsonl' | 'text';
}

export interface ConfigCategory {
  name: string;
  icon: string | null;
  files: ConfigFile[];
}

export interface ClaudeCodeListRequest {
  agent_id: string;
  scope: 'global' | 'project';
  session_id?: string;
}

export interface ClaudeCodeListResponse {
  available: boolean;
  categories: ConfigCategory[];
  error?: string;
}

export interface ClaudeCodeReadRequest {
  agent_id: string;
  scope: 'global' | 'project';
  session_id?: string;
  path: string;
  offset?: number;
  limit?: number;
}

export interface ClaudeCodeReadResponse {
  content: string;
  content_type: 'json' | 'markdown' | 'jsonl' | 'text';
  total_size: number;
  offset: number;
  has_more: boolean;
  error?: string;
}
