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

function boundIds(snapshots: readonly CapabilitySnapshot[]): Set<string> {
  return new Set(snapshots.map((item) => item.id));
}

describe('buildWorkspacePresentationModel', () => {
  it('keeps unavailable capabilities out of Workspace navigation presence', () => {
    const snapshots = [
      snapshot('files', 'unavailable'),
      snapshot('session', 'available'),
    ];
    const presences = resolveCapabilityPresences(snapshots, { surface: 'workspace' });

    const model = buildWorkspacePresentationModel({
      snapshots,
      presences,
      openedCapabilityId: 'session',
      viewBoundCapabilityIds: boundIds(snapshots),
    });

    expect(model.items.map((item) => item.snapshot.id)).toEqual(['session']);
    expect(model.opened?.snapshot.id).toBe('session');
    expect('unavailable' in model).toBe(false);
  });

  it('returns every lifecycle-visible view-bound capability in registration order without a cap', () => {
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
      viewBoundCapabilityIds: boundIds(snapshots),
    });

    expect(model.items.map((item) => item.snapshot.id)).toEqual([
      'files',
      'git',
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
      viewBoundCapabilityIds: boundIds(snapshots),
    });

    expect(model.opened?.snapshot.id).toBe('files');
    expect(model.opened?.presence.level).toBe('hidden');
    expect(model.items.map((item) => item.snapshot.id)).toEqual(['session']);
    expect('unavailable' in model).toBe(false);
  });

  it('does not re-rank stronger lifecycle presence ahead of registry order', () => {
    const snapshots = [
      snapshot('git', 'relevant'),
      snapshot('docker', 'available'),
    ];
    const presences: CapabilityPresence[] = [
      { capabilityId: 'git', surface: 'workspace', level: 'contextual' },
      { capabilityId: 'docker', surface: 'workspace', level: 'prominent' },
    ];

    const model = buildWorkspacePresentationModel({
      snapshots,
      presences,
      viewBoundCapabilityIds: boundIds(snapshots),
    });

    expect(model.items.map((item) => item.snapshot.id)).toEqual(['git', 'docker']);
  });

  it('filters lifecycle-visible capabilities that have no Workspace view binding', () => {
    const snapshots = [
      snapshot('files', 'available'),
      snapshot('terminal-keys', 'active'),
      snapshot('git', 'available'),
    ];
    const presences = resolveCapabilityPresences(snapshots, { surface: 'workspace' });

    const model = buildWorkspacePresentationModel({
      snapshots,
      presences,
      viewBoundCapabilityIds: new Set(['files', 'git']),
    });

    expect(model.items.map((item) => item.snapshot.id)).toEqual(['files', 'git']);
  });
});
