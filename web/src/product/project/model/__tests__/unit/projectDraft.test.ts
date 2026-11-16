import { describe, expect, it } from 'vitest';
import type { Project } from '@/product/project/types';
import {
  createSessionDefaults,
  draftOf,
  emptyProjectDraft,
  updatePayload,
} from '@/product/project/model/projectDraft';

const PROJECT: Project = {
  project_id: 'project-123e4567-e89b-42d3-a456-426614174000',
  name: 'Nession',
  locations: [],
  session_defaults: {
    shell: '/bin/zsh',
    env_profile_ids: ['a.env', 'b.env'],
    sandbox_policy_ref: 'sandbox/default',
  },
  created_at: 1,
  updated_at: 2,
};

describe('projectDraft Session defaults (#3649)', () => {
  it('reads the ordered declaration into the draft', () => {
    expect(draftOf(PROJECT).envProfileIds).toEqual(['a.env', 'b.env']);
    expect(emptyProjectDraft().envProfileIds).toEqual([]);
  });

  it('replaces the ENV list while preserving shell and sandbox policy', () => {
    const payload = updatePayload(PROJECT, {
      ...draftOf(PROJECT),
      envProfileIds: ['b.env'],
    });
    expect(payload.session_defaults).toEqual({
      shell: '/bin/zsh',
      env_profile_ids: ['b.env'],
      sandbox_policy_ref: 'sandbox/default',
    });
  });

  it('persists an explicit empty list when the user clears the defaults', () => {
    const payload = updatePayload(PROJECT, {
      ...draftOf(PROJECT),
      envProfileIds: [],
    });
    expect(payload.session_defaults).toEqual({
      shell: '/bin/zsh',
      env_profile_ids: [],
      sandbox_policy_ref: 'sandbox/default',
    });
  });

  it('keeps an absent defaults object absent when nothing was declared', () => {
    const project: Project = {
      project_id: PROJECT.project_id,
      name: 'Bare',
      locations: [],
      created_at: 1,
      updated_at: 2,
    };
    const payload = updatePayload(project, {
      ...emptyProjectDraft(),
      name: 'Bare',
    });
    expect(payload.session_defaults).toBeNull();
    expect(createSessionDefaults({ ...emptyProjectDraft(), name: 'Bare' })).toBeUndefined();
  });

  it('sends create defaults only when references were chosen', () => {
    expect(
      createSessionDefaults({ ...emptyProjectDraft(), name: 'New', envProfileIds: ['a.env'] }),
    ).toEqual({ env_profile_ids: ['a.env'] });
  });
});
