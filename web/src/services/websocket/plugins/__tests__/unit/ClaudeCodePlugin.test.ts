import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaudeCodePlugin } from '@/services/websocket/plugins/ClaudeCodePlugin';
import type { WebSocketServiceCore } from '@/services/websocket/types';

function createMockCore(authenticated = true): WebSocketServiceCore {
  const status: 'authenticated' | 'connected' = authenticated ? 'authenticated' : 'connected';
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    isAuthenticated: vi.fn(() => authenticated),
    getConnectionStatus: vi.fn(() => status),
    onConnectionChange: vi.fn(() => vi.fn()),
    send: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    request: vi.fn(),
    generateMessageId: vi.fn(() => 'msg_cc_1'),
    getP2PConnectionInfo: vi.fn(),
    failPending: vi.fn(),
  };
}

describe('ClaudeCodePlugin', () => {
  let plugin: ClaudeCodePlugin;
  let core: WebSocketServiceCore;

  beforeEach(() => {
    plugin = new ClaudeCodePlugin();
    core = createMockCore();
    plugin.install(core);
    vi.clearAllMocks();
  });

  it('has name "claude-code"', () => {
    expect(plugin.name).toBe('claude-code');
  });

  it('install returns a teardown (registration API contract)', () => {
    const teardown = plugin.install(core);
    expect(typeof teardown).toBe('function');
  });

  it('claudeCodeList sends extension.claude_code.list request', async () => {
    const req = { agent_id: 'a1', scope: 'global' as const };
    const resp = { available: true, categories: [] };
    (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await plugin.claudeCodeList(req);
    expect(result).toEqual(resp);
    expect(core.request).toHaveBeenCalledWith('extension.claude_code.list', req);
  });

  it('claudeCodeRead sends extension.claude_code.read request', async () => {
    const req = { agent_id: 'a1', scope: 'global' as const, path: '/test.txt' };
    const resp = { content: 'test', content_type: 'text/plain', total_size: 4, offset: 0, has_more: false };
    (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await plugin.claudeCodeRead(req);
    expect(result).toEqual(resp);
    expect(core.request).toHaveBeenCalledWith('extension.claude_code.read', req);
  });

  it('requires authentication before sending', async () => {
    const unauthCore = createMockCore(false);
    plugin.install(unauthCore);
    await expect(plugin.claudeCodeList({ agent_id: 'a1', scope: 'global' }))
      .rejects.toThrow('Not authenticated');
  });
});
