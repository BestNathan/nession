import { describe, expect, it } from 'vitest';
import { resolveCapabilityDisclosure } from '../../discovery';
import type { CapabilityId, CapabilityPresence, CapabilityPresenceLevel } from '@/product/capability';

function presence(id: CapabilityId, level: CapabilityPresenceLevel): CapabilityPresence {
  return { capabilityId: id, surface: 'workspace', level };
}

describe('capability disclosure', () => {
  it('keeps a hidden capability out of every bucket but hidden', () => {
    const disclosure = resolveCapabilityDisclosure(
      [presence('claude-code', 'hidden'), presence('docker', 'discoverable')],
      { directLimit: 2 },
    );

    expect(disclosure.direct.map((p) => p.capabilityId)).toEqual([]);
    expect(disclosure.discoverable.map((p) => p.capabilityId)).toEqual(['docker']);
    expect(disclosure.hidden.map((p) => p.capabilityId)).toEqual(['claude-code']);
  });

  it('never spends a direct slot on a merely discoverable capability', () => {
    // `available` maps to `discoverable` (see presence.ts): being registered, or
    // being installed, must not take a slot even when the surface has room.
    const disclosure = resolveCapabilityDisclosure(
      [presence('docker', 'discoverable'), presence('git', 'contextual')],
      { directLimit: 2 },
    );

    expect(disclosure.direct.map((p) => p.capabilityId)).toEqual(['git']);
    expect(disclosure.discoverable.map((p) => p.capabilityId)).toEqual(['docker']);
  });

  it('bounds direct presence by the limit the surface declares', () => {
    const presences = [
      presence('a', 'contextual'),
      presence('b', 'prominent'),
      presence('c', 'contextual'),
    ];

    expect(resolveCapabilityDisclosure(presences, { directLimit: 2 }).direct.map((p) => p.capabilityId))
      .toEqual(['b', 'a']);
    expect(resolveCapabilityDisclosure(presences, { directLimit: 1 }).direct.map((p) => p.capabilityId))
      .toEqual(['b']);
    expect(resolveCapabilityDisclosure(presences, { directLimit: 0 }).direct).toEqual([]);
  });

  it('lets the surface pin a capability it already opened, ahead of stronger candidates', () => {
    const presences = [presence('b', 'prominent'), presence('a', 'contextual')];

    const disclosure = resolveCapabilityDisclosure(presences, { directLimit: 2, pinned: ['a'] });

    expect(disclosure.direct.map((p) => p.capabilityId)).toEqual(['a', 'b']);
  });

  it('is deterministic between equally ranked capabilities', () => {
    const presences = [presence('a', 'contextual'), presence('b', 'contextual')];

    expect(resolveCapabilityDisclosure(presences, { directLimit: 2 }).direct.map((p) => p.capabilityId))
      .toEqual(['a', 'b']);
  });

  it('moves everything it could not fit into disclosure rather than dropping it', () => {
    const presences = [presence('a', 'contextual'), presence('b', 'contextual'), presence('c', 'prominent')];

    const disclosure = resolveCapabilityDisclosure(presences, { directLimit: 1 });

    expect(disclosure.direct.map((p) => p.capabilityId)).toEqual(['c']);
    expect(disclosure.discoverable.map((p) => p.capabilityId)).toEqual(['a', 'b']);
  });

  it('accounts for every presence exactly once', () => {
    const presences = [
      presence('a', 'hidden'),
      presence('b', 'discoverable'),
      presence('c', 'contextual'),
      presence('d', 'prominent'),
    ];

    const { direct, discoverable, hidden } = resolveCapabilityDisclosure(presences, { directLimit: 1 });
    const bucketed = [...direct, ...discoverable, ...hidden].map((p) => p.capabilityId).sort();

    expect(bucketed).toEqual(['a', 'b', 'c', 'd']);
  });
});
