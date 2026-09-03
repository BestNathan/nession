import type { WebSocketPlugin, WebSocketServiceCore } from '../types';

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

/**
 * Claude Code config extension capability (#593 proof case): a new transport
 * capability installed via the registration API — RequestPlugin and the core
 * needed no change to host it.
 */
export class ClaudeCodePlugin implements WebSocketPlugin {
  name = 'claude-code';

  private core!: WebSocketServiceCore;

  install(core: WebSocketServiceCore): () => void {
    this.core = core;
    // No message subscriptions — nothing to unwind (see RequestPlugin).
    return () => {};
  }

  private requireAuth(): void {
    if (!this.core.isAuthenticated()) {
      throw new Error('Not authenticated');
    }
  }

  async claudeCodeList(req: ClaudeCodeListRequest): Promise<ClaudeCodeListResponse> {
    this.requireAuth();
    return this.core.request('extension.claude_code.list', req);
  }

  async claudeCodeRead(req: ClaudeCodeReadRequest): Promise<ClaudeCodeReadResponse> {
    this.requireAuth();
    return this.core.request('extension.claude_code.read', req);
  }
}
