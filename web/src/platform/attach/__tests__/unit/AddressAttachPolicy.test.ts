import { describe, it, expect } from 'vitest';
import { AddressAttachPolicy } from '@/platform/attach/AddressAttachPolicy';
import type { AttachInfo } from '@/types';

function makeAttachInfo(): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:test',
    agent_address: 'ws://legacy/ws',
    agent_token: 'tok',
    addresses: [
      { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
      { url: 'ws://b/ws', label: 'B', network_type: 'vpn', priority: 5, status: 'reachable' },
    ],
  };
}

/** The plan is the ordered URL list (#1430) — no readiness state exists. */
function makePlan(urls: string[]): string[] {
  return urls;
}

describe('AddressAttachPolicy', () => {
  it('returns active url from plan at current index', () => {
    const policy = new AddressAttachPolicy({
      attachInfo: makeAttachInfo(),
      orderedUrls: ['ws://a/ws', 'ws://b/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressUrls: makePlan(['ws://a/ws', 'ws://b/ws']),
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
      addressUrls: makePlan(['ws://a/ws']),
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
      addressUrls: makePlan(['ws://a/ws', 'ws://b/ws']),
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
      addressUrls: makePlan(['ws://dead/ws']),
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
      addressUrls: makePlan(['ws://a/ws', 'ws://b/ws']),
      addressIndex: 0,
    });
    expect(policy.maxReconnectAttempts()).toBe(2);
  });

  it('manual override stays P2P with explicit url and no rotation', () => {
    const policy = new AddressAttachPolicy({
      attachInfo: makeAttachInfo(),
      orderedUrls: ['ws://a/ws', 'ws://b/ws'],
      manualOverride: 'ws://manual/ws',
      forcedRelay: false,
      addressUrls: makePlan(['ws://a/ws', 'ws://b/ws']),
      addressIndex: 0,
    });
    expect(policy.isP2P).toBe(true);
    expect(policy.activeUrl).toBe('ws://manual/ws');
    expect(policy.onCandidateDisconnected()).toEqual({ type: 'transport-exhausted', manualRoute: true });
  });

  it('update resets index when plan urls change', () => {
    const policy = new AddressAttachPolicy({
      attachInfo: makeAttachInfo(),
      orderedUrls: ['ws://a/ws', 'ws://b/ws'],
      manualOverride: null,
      forcedRelay: false,
      addressUrls: makePlan(['ws://a/ws', 'ws://b/ws']),
      addressIndex: 0,
    });
    policy.onCandidateDisconnected();
    expect(policy.activeUrl).toBe('ws://b/ws');
    policy.update({ addressUrls: makePlan(['ws://c/ws', 'ws://d/ws']) });
    expect(policy.activeUrl).toBe('ws://c/ws');
  });

  it('uses long reconnect budget for single legacy fallback', () => {
    const attachInfo = makeAttachInfo();
    const policy = new AddressAttachPolicy({
      attachInfo,
      orderedUrls: null,
      manualOverride: null,
      forcedRelay: false,
      addressUrls: makePlan([attachInfo.agent_address ?? 'ws://a/ws']),
      addressIndex: 0,
    });
    expect(policy.maxReconnectAttempts()).toBe(2);
  });

  describe('healthy-route preservation (#4618 SC-04)', () => {
    function policyOn(urls: string[], index = 0): AddressAttachPolicy {
      return new AddressAttachPolicy({
        attachInfo: makeAttachInfo(),
        orderedUrls: urls,
        manualOverride: null,
        forcedRelay: false,
        addressUrls: makePlan(urls),
        addressIndex: index,
      });
    }

    it('a latency-only reorder keeps the current selection (no migration)', () => {
      const policy = policyOn(['ws://a/ws', 'ws://b/ws'], 0);
      expect(policy.activeUrl).toBe('ws://a/ws');
      // b becomes faster; the standby plan reorders but the healthy route stays.
      policy.update({ addressUrls: makePlan(['ws://b/ws', 'ws://a/ws']) });
      expect(policy.activeUrl).toBe('ws://a/ws');
      expect(policy.currentIndex).toBe(1);
    });

    it('a membership change keeps the current selection while it is still a member', () => {
      const policy = policyOn(['ws://a/ws', 'ws://b/ws']);
      expect(policy.activeUrl).toBe('ws://a/ws');
      // A new candidate c appears and b is removed; a (current) survives.
      policy.update({ addressUrls: makePlan(['ws://c/ws', 'ws://a/ws']) });
      expect(policy.activeUrl).toBe('ws://a/ws');
    });

    it('resets to the best candidate only when the current address is removed', () => {
      const policy = policyOn(['ws://a/ws', 'ws://b/ws'], 0);
      policy.update({ addressUrls: makePlan(['ws://c/ws', 'ws://b/ws']) });
      expect(policy.activeUrl).toBe('ws://c/ws');
      expect(policy.currentIndex).toBe(0);
    });

    it('still rotates on a real disconnect', () => {
      const policy = policyOn(['ws://a/ws', 'ws://b/ws', 'ws://c/ws']);
      // Reorder preserves a (now index 1); a real disconnect still advances.
      policy.update({ addressUrls: makePlan(['ws://c/ws', 'ws://a/ws', 'ws://b/ws']) });
      expect(policy.activeUrl).toBe('ws://a/ws');
      expect(policy.onCandidateDisconnected()).toEqual({ type: 'next-candidate' });
      expect(policy.activeUrl).toBe('ws://b/ws');
    });
  });
});
