/**
 * Claude Code config-extension wire types (#593 proof case). Moved verbatim
 * from `services/websocket/plugins/ClaudeCodePlugin.ts`; the legacy
 * `extensions/claude-code/types.ts` keeps re-exporting them until Task 5.
 */
export interface ClaudeCodeListRequest {
  agent_id: string;
  scope: 'global' | 'project';
  session_id?: string;
}

export interface ClaudeCodeListResponse {
  available: boolean;
  categories: {
    name: string;
    icon: string | null;
    files: { path: string; size: number; content_type: string }[];
  }[];
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
  content_type: string;
  total_size: number;
  offset: number;
  has_more: boolean;
  error?: string;
}
