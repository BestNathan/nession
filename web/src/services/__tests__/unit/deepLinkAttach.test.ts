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

vi.mock('@/services/addressSelection', () => ({
  testAddresses: vi.fn().mockResolvedValue([
    { url: 'ws://fast/ws', latencyMs: 10 },
    { url: 'ws://slow/ws', latencyMs: 100 },
  ]),
  orderByLatency: vi.fn((results: { url: string }[]) => results.map((r) => r.url)),
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

  it('browser-probes addresses when probe cache is empty', async () => {
    const attachInfo = {
      mode: 'p2p' as const,
      session_id: session.session_id,
      connection_token: 'secret',
      addresses: [
        { url: 'ws://fast/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
        { url: 'ws://slow/ws', label: 'wan', network_type: 'wan', priority: 1, status: 'reachable' },
      ],
    };
    const wsService = {
      requestAttach: vi.fn().mockResolvedValue(attachInfo),
    } as unknown as WebSocketService;

    const choice = await resolveDeepLinkAttachChoice(wsService, session, new Map());

    expect(choice.orderedUrls).toEqual(['ws://fast/ws', 'ws://slow/ws']);
    expect(choice.latencies).toHaveLength(2);
  });
});
