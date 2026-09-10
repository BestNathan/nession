import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testAddresses } from '@/services/addressSelection';
import {
  resolveDeepLinkAttachChoice,
  resolveProfileAttach,
  resolveTargetChoice,
} from '@/services/deepLinkAttach';
import {
  buildOptionsFingerprint,
  type PersistedAttachChoice,
  type SessionAttachProfile,
} from '@/services/sessionAttachProfile';
import type { Session } from '@/types';

vi.mock('@/services/attachPrefs', () => ({
  loadAttachPrefs: () => ({ mode: 'auto', renderer: 'webgl' }),
}));

vi.mock('@/core/terminal-runtime/Renderer', () => ({
  detectWebGLSupport: () => true,
}));

vi.mock('@/services/addressSelection', () => ({
  testAddresses: vi.fn().mockResolvedValue([
    { url: 'ws://fast/ws', latencyMs: 10 },
    { url: 'ws://slow/ws', latencyMs: 100 },
  ]),
  orderByLatency: vi.fn((results: { url: string }[]) => results.map((r) => r.url)),
}));

// requestAttach now comes from the sessions feature singleton.
const sessionsApiMock = vi.hoisted(() => ({
  requestAttach: vi.fn(),
}));

vi.mock('@/features/sessions', () => ({ sessionsApi: sessionsApiMock }));

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
    sessionsApiMock.requestAttach.mockResolvedValue(attachInfo);
    const probeResults = new Map([
      ['agent-1', { latencies: [], orderedUrls: ['ws://fast/ws'], probedAt: 1 }],
    ]);

    const choice = await resolveDeepLinkAttachChoice(session, probeResults);

    expect(sessionsApiMock.requestAttach).toHaveBeenCalledWith(session.session_id, 'p2p');
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
    sessionsApiMock.requestAttach.mockResolvedValue(attachInfo);

    const choice = await resolveDeepLinkAttachChoice(session, new Map());

    expect(choice.orderedUrls).toEqual(['ws://fast/ws', 'ws://slow/ws']);
    expect(choice.latencies).toHaveLength(2);
  });
});

const p2pSession: Session = {
  session_id: 'agent-1:dev',
  agent_id: 'agent-1',
  session_name: 'dev',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: '2025-01-01T00:00:00Z',
};

const p2pChoice: PersistedAttachChoice = {
  mode: 'p2p',
  renderer: 'webgl',
  envRefs: [{ name: 'prod.env', source: 'server' }],
  selectedUrl: null,
};

function p2pProfile(): SessionAttachProfile {
  return {
    schemaVersion: 1,
    sessionId: 'agent-1:dev',
    agentId: 'agent-1',
    choice: p2pChoice,
    optionsFingerprint: buildOptionsFingerprint({
      mode: 'p2p',
      session_id: 'agent-1:dev',
      connection_token: 'tok',
      addresses: [{
        url: 'ws://a/ws', label: 'lan', network_type: 'lan',
        priority: 0, status: 'reachable',
      }],
    }),
    updatedAt: 1,
  };
}

describe('resolveTargetChoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a choice honouring a p2p target', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'p2p', session_id: 'agent-1:dev', connection_token: 'tok',
      addresses: [{
        url: 'ws://a/ws', label: 'lan', network_type: 'lan',
        priority: 0, status: 'reachable',
      }],
    });
    const choice = await resolveTargetChoice(p2pSession, p2pChoice, new Map(), undefined);
    // No relay override for a p2p target: requestAttach is called without a
    // third argument (Vitest matches exact call arity, no trailing undefined).
    expect(sessionsApiMock.requestAttach).toHaveBeenCalledWith('agent-1:dev', 'p2p');
    expect(choice).toMatchObject({
      mode: 'p2p', selectedUrl: null, renderer: 'webgl',
      envRefs: [{ name: 'prod.env', source: 'server' }],
    });
    expect(choice.attachInfo.connection_token).toBe('tok');
  });

  it('requests relay info for a relay target and maps manual url to relayUrl', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'relay', session_id: 'agent-1:dev', agent_address: '', connection_token: '',
      addresses: [{
        url: 'ws://relay/ws', label: 'lan', network_type: 'lan',
        priority: 0, status: 'reachable',
      }],
    });
    const choice = await resolveTargetChoice(
      p2pSession,
      { ...p2pChoice, mode: 'relay', selectedUrl: 'ws://relay/ws' },
      new Map(),
      undefined,
    );
    expect(sessionsApiMock.requestAttach).toHaveBeenCalledWith('agent-1:dev', 'relay', 'ws://relay/ws');
    expect(choice.relayUrl).toBe('ws://relay/ws');
  });

  it('live-tests candidate addresses when the probe cache is cold', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'p2p', session_id: 'agent-1:dev', connection_token: 'tok',
      addresses: [
        { url: 'ws://fast/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
        { url: 'ws://slow/ws', label: 'wan', network_type: 'wan', priority: 1, status: 'reachable' },
      ],
    });

    const choice = await resolveTargetChoice(p2pSession, p2pChoice, new Map());

    expect(testAddresses).toHaveBeenCalled();
    expect(choice.orderedUrls[0]).toBe('ws://fast/ws');
  });

  it('reuses the probe cache without live-testing addresses when warm', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'p2p', session_id: 'agent-1:dev', connection_token: 'tok',
      addresses: [
        { url: 'ws://fast/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
        { url: 'ws://slow/ws', label: 'wan', network_type: 'wan', priority: 1, status: 'reachable' },
      ],
    });
    const probe = new Map([['agent-1', { latencies: [], orderedUrls: ['ws://a/ws'], probedAt: 1 }]]);

    const choice = await resolveTargetChoice(p2pSession, p2pChoice, probe);

    expect(testAddresses).not.toHaveBeenCalled();
    expect(choice.orderedUrls).toEqual(['ws://a/ws']);
  });

  it('falls back to agent_address when no candidate addresses are advertised', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'p2p', session_id: 'agent-1:dev', connection_token: 'tok',
      agent_address: 'ws://legacy/ws',
      addresses: [],
    });

    const choice = await resolveTargetChoice(p2pSession, p2pChoice, new Map());

    expect(testAddresses).not.toHaveBeenCalled();
    expect(choice.orderedUrls).toEqual(['ws://legacy/ws']);
  });
});

describe('resolveProfileAttach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a choice when the profile is still valid', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'p2p', session_id: 'agent-1:dev', connection_token: 'tok',
      addresses: [{
        url: 'ws://a/ws', label: 'lan', network_type: 'lan',
        priority: 0, status: 'reachable',
      }],
    });
    const probe = new Map([['agent-1', { latencies: [], orderedUrls: ['ws://a/ws'], probedAt: 1 }]]);
    const resolution = await resolveProfileAttach(p2pSession, p2pProfile(), probe);
    // The replay reuses the attachInfo fetched for validation — no second request.
    expect(sessionsApiMock.requestAttach).toHaveBeenCalledTimes(1);
    expect(resolution).toMatchObject({ kind: 'choice' });
  });

  it('returns dialog when the options changed', async () => {
    sessionsApiMock.requestAttach.mockResolvedValue({
      mode: 'p2p', session_id: 'agent-1:dev', connection_token: 'tok',
      addresses: [
        { url: 'ws://a/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
        { url: 'ws://new/ws', label: 'vpn', network_type: 'vpn', priority: 0, status: 'reachable' },
      ],
    });
    const resolution = await resolveProfileAttach(p2pSession, p2pProfile(), new Map());
    expect(resolution).toEqual({ kind: 'dialog' });
  });

  it('returns dialog when the attach request fails', async () => {
    sessionsApiMock.requestAttach.mockRejectedValue(new Error('boom'));
    const resolution = await resolveProfileAttach(p2pSession, p2pProfile(), new Map());
    expect(resolution).toEqual({ kind: 'dialog' });
  });
});
