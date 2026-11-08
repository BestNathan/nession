import { beforeEach, describe, expect, it } from 'vitest';
import {
  createFixtureSessionMetadataHarness,
  FIXTURE_OWNERSHIP_SESSION_A,
  FIXTURE_OWNERSHIP_SESSION_B,
  fixtureOwnershipSessionId,
  selectFixtureOwnershipSession,
  subscribeFixtureOwnershipSession,
} from '../../fixtureSessionMetadata';

type Harness = ReturnType<typeof createFixtureSessionMetadataHarness>;

function getMetadata<T>(harness: Harness, sessionId: string): Promise<T> {
  return harness.surface.request<T>('server.session.metadata.get', {
    session_id: sessionId,
  });
}

function updateMetadata<T>(harness: Harness, payload: Record<string, unknown>): Promise<T> {
  return harness.surface.request<T>('server.session.metadata.update', payload);
}

describe('fixture Session metadata ownership route', () => {
  beforeEach(() => {
    selectFixtureOwnershipSession(FIXTURE_OWNERSHIP_SESSION_A);
  });

  it('holds a save until the Case releases it, while the other Session stays readable', async () => {
    const harness = createFixtureSessionMetadataHarness(
      '?capability=session&sessionMetadata=ownership-save',
    );
    const controls = harness.controls;
    expect(controls).not.toBeNull();

    const save = updateMetadata<{ success: boolean; metadata: { title: string } }>(harness, {
      session_id: FIXTURE_OWNERSHIP_SESSION_A,
      title: 'Saved A title',
      description: null,
      tags: [],
      expected_revision: 4,
    });
    expect(controls?.saves()).toBe(1);

    let settled = false;
    void save.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled, 'the answer is still held').toBe(false);

    // B's read is never behind A's held save.
    const b = await getMetadata<{ metadata: { title: string | null } }>(
      harness,
      FIXTURE_OWNERSHIP_SESSION_B,
    );
    expect(b.metadata.title).toBe('Design system audit');

    controls?.releaseSave();
    const answer = await save;
    expect(answer.success).toBe(true);
    expect(answer.metadata.title).toBe('Saved A title');

    const a = await getMetadata<{ metadata: { title: string | null } }>(
      harness,
      FIXTURE_OWNERSHIP_SESSION_A,
    );
    expect(a.metadata.title).toBe('Saved A title');
  });

  it('holds the forced read after a conflict until the Case releases it', async () => {
    const harness = createFixtureSessionMetadataHarness(
      '?capability=session&sessionMetadata=ownership-reload',
    );
    const controls = harness.controls;

    const conflict = await updateMetadata<{ success: boolean; error_kind: string }>(harness, {
      session_id: FIXTURE_OWNERSHIP_SESSION_A,
      title: 'My unsaved draft',
      description: null,
      tags: [],
      expected_revision: 4,
    });
    expect(conflict.success).toBe(false);
    expect(conflict.error_kind).toBe('conflict');

    controls?.holdNextRead();
    const reload = getMetadata<{ metadata: { title: string | null; revision: number } }>(
      harness,
      FIXTURE_OWNERSHIP_SESSION_A,
    );
    expect(controls?.heldRead()).toBe(true);

    let settled = false;
    void reload.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled, 'the reload is still held').toBe(false);

    // The held answer belongs to A; B still reads its own metadata.
    const b = await getMetadata<{ metadata: { title: string | null } }>(
      harness,
      FIXTURE_OWNERSHIP_SESSION_B,
    );
    expect(b.metadata.title).toBe('Design system audit');

    controls?.releaseRead();
    const answer = await reload;
    expect(answer.metadata.revision).toBe(5);
    expect(answer.metadata.title).toBe('Terminal reconnect — updated elsewhere');

    // A second write still conflicts: the same-Session negative control does
    // not depend on this route's store reaching a clean revision.
    const second = await updateMetadata<{ success: boolean; error_kind: string }>(harness, {
      session_id: FIXTURE_OWNERSHIP_SESSION_A,
      title: 'Another draft',
      description: null,
      tags: [],
      expected_revision: 5,
    });
    expect(second.success).toBe(false);
    expect(second.error_kind).toBe('conflict');
  });

  it('moves the fixture selection between the two owned Sessions and notifies once', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeFixtureOwnershipSession(() => {
      seen.push(fixtureOwnershipSessionId());
    });

    selectFixtureOwnershipSession(FIXTURE_OWNERSHIP_SESSION_B);
    expect(fixtureOwnershipSessionId()).toBe(FIXTURE_OWNERSHIP_SESSION_B);

    // Re-selecting the current Session or an unknown one is not a move.
    selectFixtureOwnershipSession(FIXTURE_OWNERSHIP_SESSION_B);
    selectFixtureOwnershipSession('devbox-01:not-owned');
    expect(seen).toEqual([FIXTURE_OWNERSHIP_SESSION_B]);

    selectFixtureOwnershipSession(FIXTURE_OWNERSHIP_SESSION_A);
    expect(seen).toEqual([FIXTURE_OWNERSHIP_SESSION_B, FIXTURE_OWNERSHIP_SESSION_A]);
    unsubscribe();
  });

  it('leaves the ordinary scenarios without browser controls', () => {
    const harness = createFixtureSessionMetadataHarness(
      '?capability=session&sessionMetadata=normal',
    );
    expect(harness.controls).toBeNull();
  });
});
