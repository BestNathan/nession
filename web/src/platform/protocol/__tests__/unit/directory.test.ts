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
    expect(directory.manifestFor('agent-a')).toBe(MANIFEST);
  });

  it('answers an agent it has never heard of exactly as one that advertised nothing', () => {
    // Both are Legacy Peers from the client's side: the call goes out naming no
    // version and relays as it did before manifests existed. The safe direction
    // matters most for the first case — *not having fetched yet* must never
    // read as *this target refused*.
    const directory = new ProtocolDirectory();
    directory.publish(new Map([['agent-a', null]]));
    expect(directory.manifestFor('agent-a')).toBeNull();
    expect(directory.manifestFor('never-listed')).toBeNull();
  });

  it('replaces wholesale, so an agent that went away cannot keep resolving', () => {
    // A merge would leave `agent-a`'s manifest behind after the server stopped
    // listing it — a stale manifest resolves to a version the target may no
    // longer serve, which is precisely the "target manifest stale" case the
    // server's gate exists to catch. Better to have no manifest and relay.
    const directory = new ProtocolDirectory();
    directory.publish(new Map([['agent-a', MANIFEST]]));
    directory.publish(new Map([['agent-b', MANIFEST]]));

    expect(directory.manifestFor('agent-a')).toBeNull();
    expect(directory.manifestFor('agent-b')).toBe(MANIFEST);
  });

  it('drops a manifest that the next snapshot stops carrying', () => {
    const directory = new ProtocolDirectory();
    directory.publish(new Map([['agent-a', MANIFEST]]));
    directory.publish(new Map([['agent-a', null]]));
    expect(directory.manifestFor('agent-a')).toBeNull();
  });
});

describe('manifestsOf', () => {
  it('keys by agent id and folds "did not say" into "advertised none"', () => {
    // `undefined` and `null` resolve identically, so the directory has no third
    // state for a caller to remember — the same shape the server sends either
    // way, but a fixture or a test is free to omit the field.
    const map = manifestsOf([
      { agent_id: 'agent-a', protocols: MANIFEST },
      { agent_id: 'agent-b', protocols: null },
      { agent_id: 'agent-c' },
    ]);

    expect(map.get('agent-a')).toBe(MANIFEST);
    expect(map.get('agent-b')).toBeNull();
    expect(map.get('agent-c')).toBeNull();
    expect(map.size).toBe(3);
  });

  it('is the input `publish` takes, so the two cannot drift', () => {
    const directory = new ProtocolDirectory();
    directory.publish(manifestsOf([{ agent_id: 'agent-a', protocols: MANIFEST }]));
    expect(directory.manifestFor('agent-a')).toBe(MANIFEST);
  });
});
