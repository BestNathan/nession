// #3424 — the fixture's controlled incarnation route stands in for an
// authoritative Session list reporting the same public id under a new durable
// tmux instance. These tests drive the production metadata owner, so a mistake
// in the fixture's transport or in the invalidation contract fails here before
// the browser Case runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsApi } from '@/product/session';
import {
  getSessionMetadataEntry,
  loadSessionMetadata,
  resetSessionMetadataCache,
} from '@/product/session/state/metadata';
import { createFixtureSessionMetadataHarness } from '../../fixtureSessionMetadata';

const SELECTED_ID = 'devbox-01:fix-terminal-reconnect';
const OLD_TITLE = 'Terminal reconnect reliability';

describe('fixture Session metadata incarnation route (#3424)', () => {
  let release: (() => void) | undefined;

  beforeEach(() => {
    resetSessionMetadataCache();
  });

  afterEach(() => {
    release?.();
    release = undefined;
    resetSessionMetadataCache();
  });

  function install() {
    const harness = createFixtureSessionMetadataHarness(
      '?capability=session&sessionMetadata=incarnation',
    );
    release = sessionsApi.install(harness.surface);
    return harness.controls!;
  }

  it('reports a new instance with fresh metadata through the production owner', async () => {
    const controls = install();
    await loadSessionMetadata(SELECTED_ID);
    expect(getSessionMetadataEntry(SELECTED_ID).metadata?.title).toBe(OLD_TITLE);

    controls.replaceIncarnation(SELECTED_ID);

    await vi.waitFor(() => {
      expect(getSessionMetadataEntry(SELECTED_ID).status).toBe('loaded');
    });
    expect(getSessionMetadataEntry(SELECTED_ID).metadata).toMatchObject({
      revision: 0,
      title: null,
    });
  });

  it('an ordinary refresh of the same incarnation keeps the loaded entry', async () => {
    const controls = install();
    await loadSessionMetadata(SELECTED_ID);

    controls.refresh(SELECTED_ID);
    controls.refresh(SELECTED_ID);

    expect(getSessionMetadataEntry(SELECTED_ID)).toMatchObject({
      status: 'loaded',
      metadata: { title: OLD_TITLE },
    });
  });
});
