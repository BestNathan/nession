import { describe, it, expect } from 'vitest';
import type { AttachInfo } from '@/types';
import {
  buildOptionsFingerprint,
  candidateUrlsOf,
  validateProfile,
  type PersistedAttachChoice,
  type SessionAttachProfile,
} from '@/services/sessionAttachProfile';

function addr(url: string, networkType = 'lan') {
  return {
    url,
    label: networkType,
    network_type: networkType as 'lan' | 'vpn',
    priority: 0,
    status: 'reachable' as const,
  };
}

function info(overrides: Partial<AttachInfo> = {}): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent-1:dev',
    connection_token: 'tok',
    agent_address: 'ws://a/ws',
    addresses: [addr('ws://a/ws')],
    ...overrides,
  };
}

const choice: PersistedAttachChoice = {
  mode: 'auto',
  renderer: 'webgl',
  envRefs: [],
  selectedUrl: null,
};

function profile(overrides: Partial<SessionAttachProfile> = {}): SessionAttachProfile {
  return {
    schemaVersion: 1,
    sessionId: 'agent-1:dev',
    agentId: 'agent-1',
    choice,
    optionsFingerprint: buildOptionsFingerprint(info()),
    updatedAt: 1,
    ...overrides,
  };
}

describe('candidateUrlsOf', () => {
  it('returns address urls', () => {
    expect(candidateUrlsOf(info())).toEqual(['ws://a/ws']);
  });

  it('falls back to agent_address when addresses are empty', () => {
    expect(candidateUrlsOf(info({ addresses: [] }))).toEqual(['ws://a/ws']);
  });
});

describe('buildOptionsFingerprint', () => {
  it('is stable across address ordering changes', () => {
    const a = info({ addresses: [addr('ws://b/ws', 'vpn'), addr('ws://a/ws', 'lan')] });
    const b = info({ addresses: [addr('ws://a/ws', 'lan'), addr('ws://b/ws', 'vpn')] });
    expect(buildOptionsFingerprint(a)).toBe(buildOptionsFingerprint(b));
  });

  it('is stable across probe-volatile fields (status, rtt)', () => {
    const a = info({ addresses: [{ ...addr('ws://a/ws'), status: 'reachable', rtt_ms: 5 }] });
    const b = info({ addresses: [{ ...addr('ws://a/ws'), status: 'unreachable', rtt_ms: 999 }] });
    expect(buildOptionsFingerprint(a)).toBe(buildOptionsFingerprint(b));
  });

  it('changes when a candidate url is added', () => {
    const a = info();
    const b = info({ addresses: [addr('ws://a/ws'), addr('ws://c/ws', 'vpn')] });
    expect(buildOptionsFingerprint(a)).not.toBe(buildOptionsFingerprint(b));
  });

  it('changes when a candidate network type changes', () => {
    const a = info();
    const b = info({ addresses: [addr('ws://a/ws', 'vpn')] });
    expect(buildOptionsFingerprint(a)).not.toBe(buildOptionsFingerprint(b));
  });

  it('changes when the effective mode changes', () => {
    const a = info();
    const b = info({ mode: 'relay' });
    expect(buildOptionsFingerprint(a)).not.toBe(buildOptionsFingerprint(b));
  });

  it('does not include the connection token', () => {
    const a = info({ connection_token: 'tok-1' });
    const b = info({ connection_token: 'tok-2' });
    expect(buildOptionsFingerprint(a)).toBe(buildOptionsFingerprint(b));
  });

  it('treats empty and absent addresses the same via the agent fallback', () => {
    expect(buildOptionsFingerprint(info({ addresses: [] }))).toBe(
      buildOptionsFingerprint(info({ addresses: undefined })),
    );
  });

  it('ignores agent_address while addresses are present', () => {
    expect(buildOptionsFingerprint(info())).toBe(
      buildOptionsFingerprint(info({ agent_address: 'ws://other/ws' })),
    );
  });

  it('encodes the legacy agent fallback differently from listed addresses', () => {
    expect(buildOptionsFingerprint(info({ addresses: [] }))).not.toBe(
      buildOptionsFingerprint(info()),
    );
  });
});

describe('validateProfile', () => {
  it('accepts a matching profile', () => {
    expect(validateProfile(profile(), info(), true)).toEqual({ ok: true });
  });

  it('rejects when the options changed', () => {
    const p = profile();
    const changed = info({ addresses: [addr('ws://a/ws'), addr('ws://new/ws', 'vpn')] });
    expect(validateProfile(p, changed, true)).toEqual({ ok: false, reason: 'fingerprint' });
  });

  it('rejects a manual url that left the candidate set', () => {
    // Stored fingerprint matches the fresh options; only the saved selection
    // is gone from the candidates → the manual-url guard, not 'fingerprint',
    // must fire. (A changed option set would be reported as 'fingerprint'.)
    const p = profile({
      choice: { ...choice, mode: 'p2p', selectedUrl: 'ws://gone/ws' },
    });
    expect(validateProfile(p, info(), true)).toEqual({ ok: false, reason: 'manual-url' });
  });

  it('accepts a manual url still present in the candidate set', () => {
    const p = profile({
      choice: { ...choice, mode: 'p2p', selectedUrl: 'ws://a/ws' },
      optionsFingerprint: buildOptionsFingerprint(info()),
    });
    expect(validateProfile(p, info(), true)).toEqual({ ok: true });
  });

  it('rejects webgl when the browser does not support it', () => {
    expect(validateProfile(profile(), info(), false)).toEqual({ ok: false, reason: 'renderer' });
  });

  it('reports fingerprint before manual-url, manual-url before renderer', () => {
    // Options changed AND the saved url left the set → 'fingerprint' wins.
    const changed = profile({
      choice: { ...choice, mode: 'p2p', selectedUrl: 'ws://gone/ws' },
      optionsFingerprint: buildOptionsFingerprint(info({ addresses: [addr('ws://gone/ws')] })),
    });
    expect(validateProfile(changed, info(), true)).toEqual({ ok: false, reason: 'fingerprint' });
    // Options stable, url gone AND webgl unsupported → 'manual-url' wins.
    // (The last link — fingerprint + url fine, webgl unsupported → 'renderer' —
    // is pinned by the renderer test above.)
    const gone = profile({
      choice: { ...choice, mode: 'p2p', selectedUrl: 'ws://gone/ws' },
    });
    expect(validateProfile(gone, info(), false)).toEqual({ ok: false, reason: 'manual-url' });
  });
});
