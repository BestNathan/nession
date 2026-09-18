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
  it('keeps unavailable capabilities out of direct and discoverable presence', () => {
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

    expect(model.primary.map((item) => item.snapshot.id)).toEqual(['session']);
    expect(model.discoverable.map((item) => item.snapshot.id)).toEqual([]);
    expect(model.opened?.snapshot.id).toBe('session');
  });

  it('keeps the opened capability direct and bounds additional contextual presence', () => {
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

    expect(model.primary.map((item) => item.snapshot.id)).toEqual(['files']);
    expect(model.contextual.map((item) => item.snapshot.id)).toEqual(['git']);
    expect(model.discoverable.map((item) => item.snapshot.id)).toEqual([
      'docker',
      'kubernetes',
    ]);
  });

  it('keeps an opened unavailable capability as stable explanatory context without exposing it', () => {
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
    expect(model.primary).toEqual([]);
    expect(model.discoverable.map((item) => item.snapshot.id)).toEqual(['session']);
  });

  it('ranks a stronger presence ahead of registration order', () => {
    const snapshots = [
      snapshot('git', 'relevant'),
      snapshot('docker', 'available'),
    ];
    // Presence levels are inputs here: this pins the Workspace *ordering* rule
    // (a stronger level outranks registration order), not how a state maps to a
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

    expect(model.contextual.map((item) => item.snapshot.id)).toEqual(['docker']);
    expect(model.discoverable.map((item) => item.snapshot.id)).toEqual(['git']);
  });
});
