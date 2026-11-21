// web/src/product/session/state/__tests__/unit/metadata.test.ts
//
// #3319 — a read that was already in flight when a save succeeded must never
// publish its older answer over the revision the Agent just committed. The
// cache owner fences by per-Session request order (not by revision: a Session
// recreated under the same name starts again at revision 0), and the negative
// controls keep failed writes and concurrent Sessions independent.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionsApiMock = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('@/product/session', () => ({ sessionsApi: sessionsApiMock }));

import {
  getSessionMetadataEntry,
  loadSessionMetadata,
  observeSessionIncarnations,
  resetSessionMetadataCache,
  saveSessionMetadata,
} from '../../metadata';
import type {
  SessionMetadata,
  SessionMetadataResponse,
} from '@/product/session/types';

const SESSION_A = 'agent-01:session-a';
const SESSION_B = 'agent-01:session-b';

function metadata(revision: number, title: string): SessionMetadata {
  return {
    revision,
    title,
    description: null,
    tags: [],
    created_at: null,
    updated_at: null,
  };
}

function loaded(revision: number, title: string): SessionMetadataResponse {
  return { success: true, metadata: metadata(revision, title) };
}

function legacy(): SessionMetadataResponse {
  return {
    success: true,
    metadata: {
      revision: 0,
      title: null,
      description: null,
      tags: [],
      created_at: null,
      updated_at: null,
    },
  };
}

function conflict(): SessionMetadataResponse {
  return {
    success: false,
    error: 'expected revision 4, current revision 5',
    error_kind: 'conflict',
    metadata: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('Session metadata cache ordering', () => {
  beforeEach(() => {
    resetSessionMetadataCache();
    sessionsApiMock.getMetadata.mockReset();
    sessionsApiMock.updateMetadata.mockReset();
  });

  it('fences a forced read that was pending when a save succeeded', async () => {
    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(4, 'Before'));
    await loadSessionMetadata(SESSION_A);

    const held = deferred<SessionMetadataResponse>();
    sessionsApiMock.getMetadata.mockReturnValueOnce(held.promise);
    const pendingRead = loadSessionMetadata(SESSION_A, { force: true });

    sessionsApiMock.updateMetadata.mockResolvedValueOnce(loaded(5, 'After'));
    const saved = await saveSessionMetadata(SESSION_A, {
      title: 'After',
      description: null,
      tags: [],
      expectedRevision: 4,
    });

    expect(saved.success).toBe(true);
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 5,
      title: 'After',
    });

    // The read started before the save, so its revision-4 answer is stale even
    // though no newer read started after it.
    held.resolve(loaded(4, 'Before'));
    await pendingRead;

    expect(getSessionMetadataEntry(SESSION_A)).toMatchObject({
      status: 'loaded',
      metadata: { revision: 5, title: 'After' },
    });
  });

  it('lets a read that starts after the save publish the committed revision', async () => {
    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(4, 'Before'));
    await loadSessionMetadata(SESSION_A);

    sessionsApiMock.updateMetadata.mockResolvedValueOnce(loaded(5, 'After'));
    await saveSessionMetadata(SESSION_A, {
      title: 'After',
      description: null,
      tags: [],
      expectedRevision: 4,
    });

    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(5, 'After'));
    await loadSessionMetadata(SESSION_A, { force: true });
    expect(getSessionMetadataEntry(SESSION_A).metadata?.revision).toBe(5);

    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(6, 'Newer elsewhere'));
    await loadSessionMetadata(SESSION_A, { force: true });
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 6,
      title: 'Newer elsewhere',
    });
  });

  it('lets a later read publish a lower revision from a recreated Session', async () => {
    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(4, 'Before'));
    await loadSessionMetadata(SESSION_A);

    sessionsApiMock.updateMetadata.mockResolvedValueOnce(loaded(5, 'After'));
    await saveSessionMetadata(SESSION_A, {
      title: 'After',
      description: null,
      tags: [],
      expectedRevision: 4,
    });

    // Killing and recreating the tmux Session starts a new metadata instance
    // at revision 0. A read this client starts after the save is authoritative;
    // the fence orders answers, it does not enforce revision monotonicity.
    sessionsApiMock.getMetadata.mockResolvedValueOnce(legacy());
    await loadSessionMetadata(SESSION_A, { force: true });

    expect(getSessionMetadataEntry(SESSION_A)).toMatchObject({
      status: 'loaded',
      metadata: { revision: 0, title: null },
    });
  });

  it('a conflicted save neither changes the cache nor fences a pending read', async () => {
    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(4, 'Before'));
    await loadSessionMetadata(SESSION_A);

    const held = deferred<SessionMetadataResponse>();
    sessionsApiMock.getMetadata.mockReturnValueOnce(held.promise);
    const pendingRead = loadSessionMetadata(SESSION_A, { force: true });

    sessionsApiMock.updateMetadata.mockResolvedValueOnce(conflict());
    const refused = await saveSessionMetadata(SESSION_A, {
      title: 'Draft',
      description: null,
      tags: [],
      expectedRevision: 4,
    });
    expect(refused.success).toBe(false);
    expect(refused.error_kind).toBe('conflict');

    // The read was not fenced by the refused write: the Agent's newer answer
    // is still allowed to update the cache.
    held.resolve(loaded(5, 'Updated elsewhere'));
    await pendingRead;
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 5,
      title: 'Updated elsewhere',
    });
  });

  it('fences and publishes per Session, not globally', async () => {
    sessionsApiMock.getMetadata
      .mockResolvedValueOnce(loaded(4, 'A before'))
      .mockResolvedValueOnce(loaded(1, 'B before'));
    await loadSessionMetadata(SESSION_A);
    await loadSessionMetadata(SESSION_B);

    const held = deferred<SessionMetadataResponse>();
    sessionsApiMock.getMetadata.mockReturnValueOnce(held.promise);
    const pendingA = loadSessionMetadata(SESSION_A, { force: true });

    sessionsApiMock.updateMetadata.mockResolvedValueOnce(loaded(2, 'B saved'));
    await saveSessionMetadata(SESSION_B, {
      title: 'B saved',
      description: null,
      tags: [],
      expectedRevision: 1,
    });

    // B's save did not fence A's pending read.
    held.resolve(loaded(4, 'A before'));
    await pendingA;

    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 4,
      title: 'A before',
    });
    expect(getSessionMetadataEntry(SESSION_B).metadata).toMatchObject({
      revision: 2,
      title: 'B saved',
    });
  });
});

// #3424 — `session_id` is recyclable. An authoritative list that reports a new
// durable tmux instance under the same public id must not leave the previous
// incarnation's name-keyed cache entry on screen, and an old-instance answer
// that resolves afterwards must not restore it.
describe('Session metadata incarnation invalidation', () => {
  beforeEach(() => {
    resetSessionMetadataCache();
    sessionsApiMock.getMetadata.mockReset();
  });

  function instance(id: string, instanceId: string | null) {
    return [{ session_id: id, instance_id: instanceId }];
  }

  it('keeps a loaded entry across ordinary refreshes of the same incarnation', async () => {
    sessionsApiMock.getMetadata.mockResolvedValue(loaded(4, 'Same incarnation'));

    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    await loadSessionMetadata(SESSION_A);
    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));

    expect(getSessionMetadataEntry(SESSION_A)).toMatchObject({
      status: 'loaded',
      metadata: { revision: 4, title: 'Same incarnation' },
    });
    // Only the explicit load asked the Agent; the refreshes did not.
    expect(sessionsApiMock.getMetadata).toHaveBeenCalledTimes(1);
  });

  it('discards the previous entry and reads the new instance', async () => {
    sessionsApiMock.getMetadata
      .mockResolvedValueOnce(loaded(4, 'Old project'))
      .mockResolvedValueOnce(legacy());

    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    await loadSessionMetadata(SESSION_A);
    expect(getSessionMetadataEntry(SESSION_A).metadata?.title).toBe('Old project');

    observeSessionIncarnations(instance(SESSION_A, 'instance-b'));

    await vi.waitFor(() => {
      expect(getSessionMetadataEntry(SESSION_A).status).toBe('loaded');
    });
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 0,
      title: null,
    });
    expect(sessionsApiMock.getMetadata).toHaveBeenCalledTimes(2);
  });

  it('fences a read started for the old incarnation when the replacement is observed', async () => {
    const oldRead = deferred<SessionMetadataResponse>();
    const newRead = deferred<SessionMetadataResponse>();
    sessionsApiMock.getMetadata
      .mockResolvedValueOnce(loaded(4, 'Old project'))
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);

    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    await loadSessionMetadata(SESSION_A);

    const pendingOld = loadSessionMetadata(SESSION_A, { force: true });
    observeSessionIncarnations(instance(SESSION_A, 'instance-b'));

    // The old instance answers after the replacement was observed. Its read
    // was fenced, so it must not publish.
    oldRead.resolve(loaded(4, 'Old project'));
    await pendingOld;
    expect(getSessionMetadataEntry(SESSION_A)).toMatchObject({
      status: 'loading',
      metadata: null,
    });

    newRead.resolve(legacy());
    await vi.waitFor(() => {
      expect(getSessionMetadataEntry(SESSION_A).status).toBe('loaded');
    });
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 0,
      title: null,
    });
  });

  it('treats an unreported legacy instance id as no incarnation change', async () => {
    sessionsApiMock.getMetadata.mockResolvedValue(loaded(4, 'Legacy still current'));

    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    await loadSessionMetadata(SESSION_A);
    observeSessionIncarnations(instance(SESSION_A, null));

    expect(getSessionMetadataEntry(SESSION_A).metadata?.title).toBe(
      'Legacy still current',
    );
    expect(sessionsApiMock.getMetadata).toHaveBeenCalledTimes(1);
  });
});

// #3748 — a save's successful answer is not automatically the cache's answer.
// If an authoritative list replaced the durable instance while the write was in
// flight, the response was committed by the previous incarnation; publishing it
// would restore its title/tags into the replacement and fence the replacement's
// own read. Both settlement orders must leave the replacement authoritative,
// while an unchanged incarnation keeps the #3319 publication and read fence.
describe('Session metadata save publication across incarnations', () => {
  beforeEach(() => {
    resetSessionMetadataCache();
    sessionsApiMock.getMetadata.mockReset();
    sessionsApiMock.updateMetadata.mockReset();
  });

  function instance(id: string, instanceId: string) {
    return [{ session_id: id, instance_id: instanceId }];
  }

  it('discards a held save answer when the replacement read settled first', async () => {
    sessionsApiMock.getMetadata
      .mockResolvedValueOnce(loaded(4, 'Old project'))
      .mockResolvedValueOnce(legacy());
    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    await loadSessionMetadata(SESSION_A);

    const heldSave = deferred<SessionMetadataResponse>();
    sessionsApiMock.updateMetadata.mockReturnValueOnce(heldSave.promise);
    const saving = saveSessionMetadata(SESSION_A, {
      title: 'Old project saved',
      description: null,
      tags: [],
      expectedRevision: 4,
    });

    // The tmux Session is recreated under the same public id and the new
    // instance's empty metadata arrives before the old save's answer.
    observeSessionIncarnations(instance(SESSION_A, 'instance-b'));
    await vi.waitFor(() => {
      expect(getSessionMetadataEntry(SESSION_A).status).toBe('loaded');
    });
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 0,
      title: null,
    });

    heldSave.resolve(loaded(5, 'Old project saved'));
    const saved = await saving;
    expect(saved.success).toBe(true);

    // The previous incarnation's committed revision must not restore itself.
    expect(getSessionMetadataEntry(SESSION_A)).toMatchObject({
      status: 'loaded',
      metadata: { revision: 0, title: null },
    });
  });

  it('discards a held save answer before the replacement read settles, without fencing it', async () => {
    const newRead = deferred<SessionMetadataResponse>();
    sessionsApiMock.getMetadata
      .mockResolvedValueOnce(loaded(4, 'Old project'))
      .mockReturnValueOnce(newRead.promise);
    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    await loadSessionMetadata(SESSION_A);

    const heldSave = deferred<SessionMetadataResponse>();
    sessionsApiMock.updateMetadata.mockReturnValueOnce(heldSave.promise);
    const saving = saveSessionMetadata(SESSION_A, {
      title: 'Old project saved',
      description: null,
      tags: [],
      expectedRevision: 4,
    });

    observeSessionIncarnations(instance(SESSION_A, 'instance-b'));
    expect(getSessionMetadataEntry(SESSION_A)).toMatchObject({
      status: 'loading',
      metadata: null,
    });

    // The old answer settles first. It owns neither the cache nor the order.
    heldSave.resolve(loaded(5, 'Old project saved'));
    await saving;
    expect(getSessionMetadataEntry(SESSION_A)).toMatchObject({
      status: 'loading',
      metadata: null,
    });

    // The replacement's read still publishes its own answer.
    newRead.resolve(legacy());
    await vi.waitFor(() => {
      expect(getSessionMetadataEntry(SESSION_A).status).toBe('loaded');
    });
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 0,
      title: null,
    });
  });

  it('publishes and fences for the unchanged incarnation', async () => {
    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(4, 'Before'));
    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    await loadSessionMetadata(SESSION_A);
    // Ordinary list refreshes report the same instance; they are not changes.
    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));

    const heldRead = deferred<SessionMetadataResponse>();
    sessionsApiMock.getMetadata.mockReturnValueOnce(heldRead.promise);
    const pendingRead = loadSessionMetadata(SESSION_A, { force: true });

    sessionsApiMock.updateMetadata.mockResolvedValueOnce(loaded(5, 'After'));
    await saveSessionMetadata(SESSION_A, {
      title: 'After',
      description: null,
      tags: [],
      expectedRevision: 4,
    });
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 5,
      title: 'After',
    });

    // The pre-save read is still fenced (#3319).
    heldRead.resolve(loaded(4, 'Before'));
    await pendingRead;
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 5,
      title: 'After',
    });
  });

  it('publishes a save that began before the first incarnation report', async () => {
    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(4, 'Before'));
    await loadSessionMetadata(SESSION_A);

    const heldSave = deferred<SessionMetadataResponse>();
    sessionsApiMock.updateMetadata.mockReturnValueOnce(heldSave.promise);
    const saving = saveSessionMetadata(SESSION_A, {
      title: 'After',
      description: null,
      tags: [],
      expectedRevision: 4,
    });

    // The Agent identifies its current instance for the first time. That is a
    // report, not a replacement (#3424), so the in-flight save still owns the
    // cache answer.
    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    heldSave.resolve(loaded(5, 'After'));
    await saving;
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 5,
      title: 'After',
    });
  });

  it('publishes a save made against the replacement itself', async () => {
    sessionsApiMock.getMetadata
      .mockResolvedValueOnce(loaded(4, 'Old project'))
      .mockResolvedValueOnce(legacy());
    observeSessionIncarnations(instance(SESSION_A, 'instance-a'));
    await loadSessionMetadata(SESSION_A);
    observeSessionIncarnations(instance(SESSION_A, 'instance-b'));
    await vi.waitFor(() => {
      expect(getSessionMetadataEntry(SESSION_A).status).toBe('loaded');
    });

    sessionsApiMock.updateMetadata.mockResolvedValueOnce(loaded(1, 'New instance saved'));
    await saveSessionMetadata(SESSION_A, {
      title: 'New instance saved',
      description: null,
      tags: [],
      expectedRevision: 0,
    });
    expect(getSessionMetadataEntry(SESSION_A).metadata).toMatchObject({
      revision: 1,
      title: 'New instance saved',
    });
  });
});
