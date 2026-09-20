import { describe, expect, it } from 'vitest';
import {
  addressedPayload,
  refusalMessage,
  resolveContract,
  selectVersion,
  type ProtocolManifest,
} from '@/platform/protocol';

function manifest(protocols: ProtocolManifest['protocols'], software?: string): ProtocolManifest {
  return software === undefined
    ? { provider: 'agent-a', protocols }
    : { provider: 'agent-a', protocols, software_version: software };
}

describe('selectVersion', () => {
  it('picks the highest version both sides offer, not the provider’s newest', () => {
    // The design's own example. v3 is right there and must not be chosen: the
    // consumer cannot read it, and a resolver that returns the newest sends a
    // payload nobody can parse.
    expect(selectVersion([1, 2], [1, 3])).toBe(1);
    expect(selectVersion([1, 2], [1, 2, 3])).toBe(2);
  });

  it('does not assume versions are contiguous', () => {
    // `[1, 3]` is a legitimate answer set. A consumer that speaks v1 and v3
    // does *not* speak v2, so a resolver that treats the list as a floor — or
    // that walks down from the provider's maximum — answers 2 here and sends a
    // payload nobody declared they could read.
    expect(selectVersion([1, 3], [1, 2])).toBe(1);
    expect(selectVersion([2, 4], [1, 3])).toBeNull();
    expect(selectVersion([3], [1, 2, 3])).toBe(3);
  });

  it('answers null when nothing is shared, including from an empty side', () => {
    expect(selectVersion([1], [2])).toBeNull();
    expect(selectVersion([], [1, 2])).toBeNull();
    expect(selectVersion([1, 2], [])).toBeNull();
  });
});

describe('resolveContract', () => {
  it('resolves a unit the target advertises at a version we speak', () => {
    const m = manifest({ 'git.status': { versions: [1, 2] } });
    expect(resolveContract('git.status', [1], m)).toEqual({ kind: 'resolved', version: 1 });
  });

  it('keeps "never claimed it" apart from "claims it at versions we cannot read"', () => {
    // Two different sentences to a reader: one names a target that has no git
    // at all, the other names a target that has git and needs a newer client.
    // Collapsing them reports "unsupported" for both and hides who must move.
    const withoutGit = manifest({ 'git.diff': { versions: [1] } });
    expect(resolveContract('git.status', [1], withoutGit)).toEqual({ kind: 'not-advertised' });

    const v2Only = manifest({ 'git.status': { versions: [2] } });
    expect(resolveContract('git.status', [1], v2Only)).toEqual({
      kind: 'no-common-version',
      offered: [2],
    });
  });

  it('treats an absent manifest as a Legacy Peer rather than a refusal', () => {
    // The design's rule, and the reason `legacy` is its own outcome: a peer
    // that has not spoken must not be read as one that said no. It relays
    // exactly as it did before manifests existed, which means naming no version.
    expect(resolveContract('git.status', [1], null)).toEqual({ kind: 'legacy' });
    expect(resolveContract('git.status', [1], undefined)).toEqual({ kind: 'legacy' });
  });

  it('is unchanged by the software version', () => {
    // The design forbids guessing protocol compatibility from a release number.
    // Pinned here as well as in Rust because this is the copy that would
    // otherwise be tempted to: the server's answer and this one have to agree,
    // or the client resolves a version the server then refuses.
    const protocols = { 'git.status': { versions: [1] } };
    const ancient = resolveContract('git.status', [1], manifest(protocols, '0.0.1'));
    const future = resolveContract('git.status', [1], manifest(protocols, '99.0.0'));
    expect(ancient).toEqual(future);
    expect(ancient).toEqual({ kind: 'resolved', version: 1 });
  });
});

describe('refusalMessage', () => {
  it('is null when there is nothing to refuse', () => {
    expect(refusalMessage('git.status', 'agent-a', { kind: 'resolved', version: 1 })).toBeNull();
    expect(refusalMessage('git.status', 'agent-a', { kind: 'legacy' })).toBeNull();
  });

  it('names the target that has no such contract', () => {
    expect(refusalMessage('git.status', 'agent-a', { kind: 'not-advertised' })).toBe(
      '`agent-a` does not advertise `git.status`',
    );
  });

  it('names both sides when there is no shared version', () => {
    // Both sides, for the reason the server's refusal names both: "version not
    // supported" is not actionable, and the reader needs to know who moves.
    const message = refusalMessage('git.status', 'agent-a', {
      kind: 'no-common-version',
      offered: [1, 2],
    });
    expect(message).toBe('`agent-a` offers `git.status` at [v1, v2], which this client cannot read');
  });
});

describe('addressedPayload', () => {
  const m = manifest({ 'git.status': { versions: [1, 2] } });

  it('adds the resolved version to the payload it was given', () => {
    expect(
      addressedPayload({
        unit: 'git.status',
        target: 'agent-a',
        requirements: [1],
        manifest: m,
        payload: { agent_id: 'agent-a', session: 'a:work' },
      }),
    ).toEqual({ agent_id: 'agent-a', session: 'a:work', contract_version: 1 });
  });

  it('sends no contract_version to a Legacy Peer', () => {
    // Not `contract_version: 1`. Absence is not a claim about versions, and a
    // peer that predates manifests is not being downgraded — it is being
    // addressed exactly as it was before any of this existed.
    const payload = addressedPayload({
      unit: 'git.status',
      target: 'agent-a',
      requirements: [1],
      manifest: null,
      payload: { agent_id: 'agent-a', session: 'a:work' },
    });
    expect(payload).not.toHaveProperty('contract_version');
    expect(payload).toEqual({ agent_id: 'agent-a', session: 'a:work' });
  });

  it('refuses locally rather than sending an unversioned v1 payload to a v2 target', () => {
    // The failure this prevents: a target serving only v2 gets a v1-shaped
    // payload because the caller sent nothing, and "sending nothing" is not a
    // refusal — it is the Legacy Peer path. The server's own check cannot catch
    // this, because a caller that names no version is relayed as it always was.
    expect(() =>
      addressedPayload({
        unit: 'git.status',
        target: 'agent-a',
        requirements: [1],
        manifest: manifest({ 'git.status': { versions: [2] } }),
        payload: { agent_id: 'agent-a', session: 'a:work' },
      }),
    ).toThrow('`agent-a` offers `git.status` at [v2], which this client cannot read');
  });

  it('refuses a unit the target does not serve', () => {
    expect(() =>
      addressedPayload({
        unit: 'git.status',
        target: 'agent-a',
        requirements: [1],
        manifest: manifest({ 'git.diff': { versions: [1] } }),
        payload: { agent_id: 'agent-a' },
      }),
    ).toThrow('`agent-a` does not advertise `git.status`');
  });
});
