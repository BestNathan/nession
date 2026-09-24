import { describe, expect, it } from 'vitest';
import { manifestsOf, ProtocolDirectory, type ProtocolManifest } from '@/platform/protocol';

const MANIFEST: ProtocolManifest = {
  provider: 'agent-a',
  protocols: { 'git.status': { versions: [1] } },
};

describe('ProtocolDirectory', () => {
  it('answers a published agent with its manifest', () => {
    const directory = new ProtocolDirectory();
    directory.publish(new Map([['agent-a', MANIFEST]]));
    expect(directory.targetProtocols('agent-a')).toEqual({ kind: 'present', manifest: MANIFEST });
  });

  it('tells an agent it has never heard of apart from one that advertised nothing', () => {
    // These used to be the same answer — `null` — and the note defending that
    // called collapsing them "the safe direction". It was the opposite: it made
    // *not having fetched yet* resolve to *relay this unversioned*, which is a
    // manifest still in flight reading as a negotiation that succeeded.
    //
    // They are different facts and they now say so. Both refuse, and only one
    // of them is worth retrying.
    const directory = new ProtocolDirectory();
    directory.publish(new Map([['agent-a', null]]));

    expect(directory.targetProtocols('agent-a')).toEqual({ kind: 'none' });
    expect(directory.targetProtocols('never-listed')).toEqual({ kind: 'unknown' });
    expect(directory.targetProtocols('agent-a')).not.toEqual(
      directory.targetProtocols('never-listed'),
    );
  });

  it('answers unknown for everything before the first publish', () => {
    // The state the whole change is about: a connection that has not received
    // an agent list yet. There is no manifest to be had, and there must be no
    // outcome here that a caller can read as "go ahead".
    const directory = new ProtocolDirectory();
    expect(directory.targetProtocols('agent-a')).toEqual({ kind: 'unknown' });
  });

  it('replaces wholesale, so an agent that went away cannot keep resolving', () => {
    // A merge would leave `agent-a`'s manifest behind after the server stopped
    // listing it — a stale manifest resolves to a version the target may no
    // longer serve, which is precisely the "target manifest stale" case the
    // server's gate exists to catch. `unknown` is the honest answer, and it
    // refuses rather than relaying.
    const directory = new ProtocolDirectory();
    directory.publish(new Map([['agent-a', MANIFEST]]));
    directory.publish(new Map([['agent-b', MANIFEST]]));

    expect(directory.targetProtocols('agent-a')).toEqual({ kind: 'unknown' });
    expect(directory.targetProtocols('agent-b')).toEqual({ kind: 'present', manifest: MANIFEST });
  });

  it('drops a manifest that the next snapshot stops carrying', () => {
    // Still `none`, not `unknown`: the snapshot named this agent, and what it
    // said about it is that it advertises nothing. That is a fact about the
    // target, which is why it does not collapse back into our own gap.
    const directory = new ProtocolDirectory();
    directory.publish(new Map([['agent-a', MANIFEST]]));
    directory.publish(new Map([['agent-a', null]]));
    expect(directory.targetProtocols('agent-a')).toEqual({ kind: 'none' });
  });
});

describe('manifestsOf', () => {
  it('keys by agent id and folds "did not say" into "advertised none"', () => {
    // `undefined` and `null` are the same answer here and that is still right:
    // both come from a snapshot that *named* this agent, so neither is
    // `unknown`. `unknown` is the id being absent altogether, which only the
    // directory can see.
    const map = manifestsOf([
      { agent_id: 'agent-a', protocols: MANIFEST },
      { agent_id: 'agent-b', protocols: null },
      { agent_id: 'agent-c' },
    ]);

    expect(map.get('agent-a')).toBe(MANIFEST);
    expect(map.get('agent-b')).toBeNull();
    expect(map.get('agent-c')).toBeNull();
    expect(map.size).toBe(3);
    // Absence, not a `null` entry — the distinction `targetProtocols` reads.
    expect(map.has('agent-d')).toBe(false);
  });

  it('is the input `publish` takes, so the two cannot drift', () => {
    const directory = new ProtocolDirectory();
    directory.publish(manifestsOf([{ agent_id: 'agent-a', protocols: MANIFEST }]));
    expect(directory.targetProtocols('agent-a')).toEqual({ kind: 'present', manifest: MANIFEST });
  });
});
