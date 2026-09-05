import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';
import type { ClaudeCodeListRequest, ClaudeCodeListResponse, ClaudeCodeReadRequest, ClaudeCodeReadResponse } from './types';

/**
 * claude-code capability — the Claude Code config-browser extension
 * (`extension.claude_code.list|read`, issue #593). The request objects are
 * forwarded whole — the transport never sees individual fields. Wire strings
 * live only in this file; the typed API is what consumers import (module
 * singleton in index.ts).
 */
export class ClaudeCodePlugin implements CapabilityPlugin {
  readonly name = 'claude-code';

  private connection: PluginSurface | null = null;
  private generation = 0;

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount); the returned
   * teardown is generation-guarded so a stale release can never detach the
   * newer binding.
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;
    return () => {
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  /** List the config files an agent can expose for a scope. */
  async claudeCodeList(req: ClaudeCodeListRequest): Promise<ClaudeCodeListResponse> {
    return this.requireConnection().request<ClaudeCodeListResponse>(
      'extension.claude_code.list',
      { ...req },
    );
  }

  /** Read a chunk of one exposed config file. */
  async claudeCodeRead(req: ClaudeCodeReadRequest): Promise<ClaudeCodeReadResponse> {
    return this.requireConnection().request<ClaudeCodeReadResponse>(
      'extension.claude_code.read',
      { ...req },
    );
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('claude-code feature is not connected');
    }
    return this.connection;
  }
}
