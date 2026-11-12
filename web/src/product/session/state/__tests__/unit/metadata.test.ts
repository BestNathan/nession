// web/src/product/session/state/__tests__/unit/metadata.test.ts
//
// #3319 — a read that was already in flight when a save succeeded must never
// publish its older answer over the revision the Agent just committed. The
// cache owner fences by per-Session order and keeps revisions monotonic; the
// negative controls keep failed writes and concurrent Sessions independent.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionsApiMock = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('@/product/session', () => ({ sessionsApi: sessionsApiMock }));

import {
  getSessionMetadataEntry,
  loadSessionMetadata,
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

  it('keeps the committed revision when an answer is older than it', async () => {
    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(4, 'Before'));
    await loadSessionMetadata(SESSION_A);

    sessionsApiMock.updateMetadata.mockResolvedValueOnce(loaded(5, 'After'));
    await saveSessionMetadata(SESSION_A, {
      title: 'After',
      description: null,
      tags: [],
      expectedRevision: 4,
    });

    // The request is newer than the save, but the Agent's answer predates the
    // committed revision. It must not roll the cache back, and the read's
    // loading state must not be left behind.
    sessionsApiMock.getMetadata.mockResolvedValueOnce(loaded(4, 'Before'));
    await loadSessionMetadata(SESSION_A, { force: true });

    expect(getSessionMetadataEntry(SESSION_A)).toMatchObject({
      status: 'loaded',
      metadata: { revision: 5, title: 'After' },
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
