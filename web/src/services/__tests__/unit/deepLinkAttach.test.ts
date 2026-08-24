import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveDeepLinkAttachChoice } from '@/services/deepLinkAttach';
import type { Session } from '@/types';
import type { WebSocketService } from '@/services/websocket';

vi.mock('@/services/attachPrefs', () => ({
  loadAttachPrefs: () => ({ mode: 'auto', renderer: 'webgl' }),
}));

vi.mock('@/terminal/Renderer', () => ({
  detectWebGLSupport: () => true,
}));

describe('resolveDeepLinkAttachChoice', () => {
  const session: Session = {
    session_id: 'agent-1:s1',
    agent_id: 'agent-1',
    session_name: 's1',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2025-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls requestAttach and includes probe cache in choice', async () => {
    const attachInfo = {
      mode: 'p2p' as const,
      session_id: session.session_id,
      connection_token: 'secret',
      agent_address: 'ws://agent/ws',
    };
    const wsService = {
      requestAttach: vi.fn().mockResolvedValue(attachInfo),
    } as unknown as WebSocketService;
    const probeResults = new Map([
      ['agent-1', { latencies: [], orderedUrls: ['ws://fast/ws'], probedAt: 1 }],
    ]);

    const choice = await resolveDeepLinkAttachChoice(wsService, session, probeResults);

    expect(wsService.requestAttach).toHaveBeenCalledWith(session.session_id, 'p2p');
    expect(choice.attachInfo).toEqual(attachInfo);
    expect(choice.orderedUrls).toEqual(['ws://fast/ws']);
    expect(choice.mode).toBe('auto');
  });
});
