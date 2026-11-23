// #4234 — the fixture's Project wire must enforce the same revision and
// incarnation preconditions as the Server, or the browser Case would prove a
// stale editor against a stub that cannot reject it. These tests drive the
// production SessionsPlugin, so a mistake in the fixture or the wire contract
// fails here before the browser Case runs.
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsApi } from '@/product/session';
import { createFixtureSessionMetadataHarness } from '../../fixtureSessionMetadata';

const SESSION_ID = 'devbox-01:fix-terminal-reconnect';
const PROJECT_ONE = 'project-00000000-0000-4000-8000-000000000001';
const PROJECT_TWO = 'project-00000000-0000-4000-8000-000000000002';

describe('fixture Session Project revision wire (#4234)', () => {
  let release: (() => void) | undefined;

  afterEach(() => {
    release?.();
    release = undefined;
  });

  function install() {
    const harness = createFixtureSessionMetadataHarness('', {
      initialBindings: { [SESSION_ID]: PROJECT_ONE },
    });
    release = sessionsApi.install(harness.surface);
    return harness;
  }

  it('commits the observed revision and rejects a stale one with the current token', async () => {
    const harness = install();

    const changed = await sessionsApi.setProjectBinding(SESSION_ID, PROJECT_TWO, {
      revision: 1,
    });
    expect(changed).toMatchObject({
      success: true,
      project_id: PROJECT_TWO,
      revision: 2,
    });

    const stale = await sessionsApi.setProjectBinding(SESSION_ID, PROJECT_ONE, {
      revision: 1,
    });
    expect(stale).toMatchObject({
      success: false,
      error_kind: 'conflict',
      revision: 2,
    });
    expect(harness.projectControls.bindings()).toMatchObject({
      [SESSION_ID]: PROJECT_TWO,
    });
  });

  it('removal reports the unassociated token but keeps the generation', async () => {
    const harness = install();

    const removed = await sessionsApi.setProjectBinding(SESSION_ID, null, {
      revision: 1,
    });
    expect(removed).toMatchObject({ success: true, revision: 0 });

    const stale = await sessionsApi.setProjectBinding(SESSION_ID, PROJECT_ONE, {
      revision: 1,
    });
    expect(stale).toMatchObject({
      success: false,
      error_kind: 'conflict',
      revision: 0,
    });

    const reassociated = await sessionsApi.setProjectBinding(SESSION_ID, PROJECT_TWO, {
      revision: 0,
    });
    expect(reassociated).toMatchObject({
      success: true,
      project_id: PROJECT_TWO,
      revision: 3,
    });
    expect(harness.projectControls.bindings()).toMatchObject({
      [SESSION_ID]: PROJECT_TWO,
    });
  });

  it('rejects a write aimed at another incarnation', async () => {
    install();

    const wrong = await sessionsApi.setProjectBinding(SESSION_ID, PROJECT_TWO, {
      revision: 1,
      instanceId: 'fixture-instance-0',
    });
    expect(wrong).toMatchObject({
      success: false,
      error_kind: 'conflict',
      revision: 1,
    });

    const right = await sessionsApi.setProjectBinding(SESSION_ID, PROJECT_TWO, {
      revision: 1,
      instanceId: 'fixture-instance-1',
    });
    expect(right).toMatchObject({ success: true, project_id: PROJECT_TWO });
  });
});
