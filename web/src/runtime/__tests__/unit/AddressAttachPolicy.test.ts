import { describe, it, expect } from 'vitest';
import { AddressAttachPolicy } from '@/runtime/AddressAttachPolicy';
import type { AttachInfo } from '@/types';
import type { AddressPlan } from '@/hooks/useAddressPlan';

function makeAttachInfo(): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:test',
    agent_address: 'ws://legacy/ws',
    connection_token: 'tok',
    addresses: [
      { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
      { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
    ],
  };
}

function makePlan(urls: string[]): AddressPlan {
  return { ready: true, urls };
}

describe('AddressAttachPolicy', () => {
  it('returns active url from plan at current index', () => {
    const policy = new AddressAttachPolicy({
      attachInfo: makeAttachInfo(),
      orderedUrls: ['ws://a/ws', 'ws://b/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: makePlan(['ws://a/ws', 'ws://b/ws']),
      addressIndex: 0,
    });
    expect(policy.activeUrl).toBe('ws://a/ws');
  });

  it('returns null when forced to relay', () => {
    const policy = new AddressAttachPolicy({
      attachInfo: makeAttachInfo(),
      orderedUrls: null,
      manualOverride: null,
      forcedRelay: true,
      addressPlan: makePlan(['ws://a/ws']),
      addressIndex: 0,
    });
    expect(policy.activeUrl).toBeNull();
  });

  it('advances to next candidate on disconnect', () => {
    const policy = new AddressAttachPolicy({
      attachInfo: makeAttachInfo(),
      orderedUrls: ['ws://a/ws', 'ws://b/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: makePlan(['ws://a/ws', 'ws://b/ws']),
      addressIndex: 0,
    });
    expect(policy.onCandidateDisconnected()).toEqual({ type: 'next-candidate' });
    expect(policy.activeUrl).toBe('ws://b/ws');
  });

  it('forces relay when last candidate fails', () => {
    const policy = new AddressAttachPolicy({
      attachInfo: makeAttachInfo(),
      orderedUrls: ['ws://dead/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: makePlan(['ws://dead/ws']),
      addressIndex: 0,
    });
    expect(policy.onCandidateDisconnected()).toEqual({ type: 'force-relay' });
  });

  it('uses short reconnect budget when more candidates remain', () => {
    const policy = new AddressAttachPolicy({
      attachInfo: makeAttachInfo(),
      orderedUrls: ['ws://a/ws', 'ws://b/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressPlan: makePlan(['ws://a/ws', 'ws://b/ws']),
      addressIndex: 0,
    });
    expect(policy.maxReconnectAttempts()).toBe(2);
  });
});
