import { describe, expect, it } from 'vitest';
import {
  resolveCapabilityPresences,
  type CapabilityPresence,
  type CapabilitySnapshot,
} from '@/product/capability';
import { buildWorkspacePresentationModel } from '../../presentation';

function snapshot(id: string, state: CapabilitySnapshot['state']): CapabilitySnapshot {
  return {
    id,
    title: id,
    scope: { sessionId: 'agent-a:dev' },
    state,
  };
}

describe('buildWorkspacePresentationModel', () => {
  it('keeps unavailable capabilities out of direct and discoverable presence, carried as inert entries', () => {
    const snapshots = [
      snapshot('files', 'unavailable'),
      snapshot('session', 'available'),
    ];
    const presences = resolveCapabilityPresences(snapshots, { surface: 'workspace' });

    const model = buildWorkspacePresentationModel({
      snapshots,
      presences,
      openedCapabilityId: 'session',
    });

    expect(model.direct.map((item) => item.snapshot.id)).toEqual(['session']);
    expect(model.discoverable.map((item) => item.snapshot.id)).toEqual([]);
    expect(model.opened?.snapshot.id).toBe('session');
    // Carried, not dropped: a surface renders these inert rather than letting
    // the row's membership change under the reader.
    expect(model.unavailable.map((item) => item.snapshot.id)).toEqual(['files']);
  });

  it('keeps the opened capability direct, bounded by the cap, and in registration order', () => {
    const snapshots = [
      snapshot('files', 'available'),
      snapshot('git', 'relevant'),
      snapshot('docker', 'active'),
      snapshot('kubernetes', 'relevant'),
    ];
    const presences = resolveCapabilityPresences(snapshots, { surface: 'workspace' });

    const model = buildWorkspacePresentationModel({
      snapshots,
      presences,
      openedCapabilityId: 'files',
      directLimit: 2,
    });

    // One list, registration order. The opened capability's privilege is its
    // slot, not its position — the row no longer reshuffles on activation
    // (owner follow-up, 2026-10-03).
    expect(model.direct.map((item) => item.snapshot.id)).toEqual(['files', 'git']);
    expect(model.discoverable.map((item) => item.snapshot.id)).toEqual([
      'docker',
      'kubernetes',
    ]);
  });

  it('keeps an opened unavailable capability as stable explanatory context, unranked', () => {
    const snapshots = [
      snapshot('files', 'unavailable'),
      snapshot('session', 'available'),
    ];
    const presences = resolveCapabilityPresences(snapshots, { surface: 'workspace' });

    const model = buildWorkspacePresentationModel({
      snapshots,
      presences,
      openedCapabilityId: 'files',
    });

    expect(model.opened?.snapshot.id).toBe('files');
    expect(model.opened?.presence.level).toBe('hidden');
    expect(model.direct).toEqual([]);
    expect(model.discoverable.map((item) => item.snapshot.id)).toEqual(['session']);
    // It is explanatory context *and* an inert entry — the surface shows which
    // capability the reader is stuck on without letting it rank as chrome.
    expect(model.unavailable.map((item) => item.snapshot.id)).toEqual(['files']);
  });

  it('ranks a stronger presence ahead of registration order for the slot cap', () => {
    const snapshots = [
      snapshot('git', 'relevant'),
      snapshot('docker', 'available'),
    ];
    // Presence levels are inputs here: this pins the Workspace *membership*
    // rule (a stronger level wins the bounded slot), not how a state maps to a
    // level — that mapping is the presence policy's, tested in presence.test.ts.
    const presences: CapabilityPresence[] = [
      { capabilityId: 'git', surface: 'workspace', level: 'contextual' },
      { capabilityId: 'docker', surface: 'workspace', level: 'prominent' },
    ];

    const model = buildWorkspacePresentationModel({
      snapshots,
      presences,
      directLimit: 1,
    });

    expect(model.direct.map((item) => item.snapshot.id)).toEqual(['docker']);
    expect(model.discoverable.map((item) => item.snapshot.id)).toEqual(['git']);
  });

  it('hands the direct list back in registration order even when the pinned one leads', () => {
    // `resolveCapabilityDisclosure` leads with the pinned capability; the model
    // deliberately undoes that ordering, because placement is registration's
    // and the opened entry is marked in place.
    const snapshots = [
      snapshot('files', 'relevant'),
      snapshot('git', 'relevant'),
      snapshot('env', 'relevant'),
    ];
    const presences = resolveCapabilityPresences(snapshots, { surface: 'workspace' });

    const model = buildWorkspacePresentationModel({
      snapshots,
      presences,
      openedCapabilityId: 'env',
      directLimit: 3,
    });

    expect(model.direct.map((item) => item.snapshot.id)).toEqual(['files', 'git', 'env']);
  });
});
