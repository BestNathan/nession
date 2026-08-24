import { describe, it, expect } from 'vitest';
import { resolveAutoP2pUrl } from '@/lib/resolveAutoP2pUrl';
import type { AttachInfo } from '@/types';

const p2pInfo: AttachInfo = {
  mode: 'p2p',
  session_id: 'a:s',
  connection_token: 'tok',
  agent_address: 'ws://agent/ws',
  addresses: [{ url: 'ws://first/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' }],
};

describe('resolveAutoP2pUrl', () => {
  it('prefers orderedUrls from attach choice', () => {
    expect(resolveAutoP2pUrl(['ws://ordered/ws'], ['ws://probe/ws'], p2pInfo)).toBe('ws://ordered/ws');
  });

  it('falls back to probe cache when orderedUrls empty', () => {
    expect(resolveAutoP2pUrl([], ['ws://probe/ws'], p2pInfo)).toBe('ws://probe/ws');
  });

  it('falls back to agent_address then first candidate', () => {
    expect(resolveAutoP2pUrl([], [], p2pInfo)).toBe('ws://agent/ws');
    const noAgent = { ...p2pInfo, agent_address: undefined };
    expect(resolveAutoP2pUrl([], [], noAgent)).toBe('ws://first/ws');
  });

  it('returns null for relay or missing attach info', () => {
    expect(resolveAutoP2pUrl([], [], null)).toBeNull();
    expect(resolveAutoP2pUrl([], [], { mode: 'relay', session_id: 'a:s', connection_token: 'tok' })).toBeNull();
  });
});
