// #3319 — the late-read route must capture a read's answer before a save that
// lands while the answer is held, so the Case can release the older revision
// after the successful write.
import { describe, expect, it } from 'vitest';
import {
  createFixtureSessionMetadataHarness,
  FIXTURE_OWNERSHIP_SESSION_A,
  fixtureSessionMetadataScenario,
} from '../../fixtureSessionMetadata';

type Harness = ReturnType<typeof createFixtureSessionMetadataHarness>;

interface MetadataAnswer {
  success: boolean;
  metadata: { revision: number; title: string | null } | null;
}

function getMetadata(harness: Harness, sessionId: string): Promise<MetadataAnswer> {
  return harness.surface.request<MetadataAnswer>('server.session.metadata.get', {
    session_id: sessionId,
  });
}

function updateMetadata(
  harness: Harness,
  payload: Record<string, unknown>,
): Promise<MetadataAnswer> {
  return harness.surface.request<MetadataAnswer>('server.session.metadata.update', payload);
}

describe('fixture Session metadata late-read route', () => {
  it('captures the pre-save answer and holds it until the Case releases it', async () => {
    expect(fixtureSessionMetadataScenario('?sessionMetadata=late-read')).toBe('late-read');
    const harness = createFixtureSessionMetadataHarness(
      '?capability=session&sessionMetadata=late-read',
    );
    const controls = harness.controls;
    expect(controls).not.toBeNull();

    const initial = await getMetadata(harness, FIXTURE_OWNERSHIP_SESSION_A);
    expect(initial.metadata).toMatchObject({
      revision: 4,
      title: 'Terminal reconnect reliability',
    });

    controls?.holdNextRead();
    const lateRead = getMetadata(harness, FIXTURE_OWNERSHIP_SESSION_A);
    expect(controls?.heldRead()).toBe(true);

    // The answer was captured before this save, and the save still lands.
    const saved = await updateMetadata(harness, {
      session_id: FIXTURE_OWNERSHIP_SESSION_A,
      title: 'After the save',
      description: null,
      tags: [],
      expected_revision: 4,
    });
    expect(saved.success).toBe(true);
    expect(saved.metadata?.revision).toBe(5);

    // A read started after the save answers with the committed revision.
    const after = await getMetadata(harness, FIXTURE_OWNERSHIP_SESSION_A);
    expect(after.metadata?.revision).toBe(5);

    controls?.releaseRead();
    const late = await lateRead;
    expect(late.metadata).toMatchObject({
      revision: 4,
      title: 'Terminal reconnect reliability',
    });
    expect(controls?.heldRead()).toBe(false);
  });

  it('is not a controlled scenario by default', () => {
    const harness = createFixtureSessionMetadataHarness(
      '?capability=session&sessionMetadata=normal',
    );
    expect(harness.controls).toBeNull();
  });
});
