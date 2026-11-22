'use strict';
// #4234 SC-01: two Web/App clients edit the same Session membership from
// revision R. After B commits a removal, A's stale save must return a visible
// conflict, leave B's committed state unchanged and keep A's selection for an
// explicit retry at the fresh token. The unassociated first association and
// the remove/reassociate ABA sequence carry the same token discipline.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const BOUND_ID = 'devbox-01:fix-terminal-reconnect';
const UNBOUND_ID = 'macbook:dotfiles';
const PROJECT_ONE = 'project-00000000-0000-4000-8000-000000000001'; // Nession
const PROJECT_TWO = 'project-00000000-0000-4000-8000-000000000002'; // Ops notes
const CONFLICT = '[data-testid="session-project-error"][data-conflict="true"]';

async function focusRow(page, sessionId) {
  await page
    .locator(`[data-session-row="${sessionId}"]`)
    .getByRole('button')
    .first()
    .click();
}

async function openEditor(page, sessionId) {
  await page.getByTestId(`session-actions-${sessionId}`).click();
  await page.getByTestId(`session-actions-project-${sessionId}`).click();
  await expect(page.getByTestId('session-project-dialog')).toBeVisible();
}

async function chooseProject(page, name) {
  await page.getByTestId('session-project-trigger').click();
  await page.getByRole('option', { name }).click();
}

function setRequests(page) {
  return page.evaluate(() => window.fixtureSessionProject?.setRequests() ?? []);
}

function bindings(page) {
  return page.evaluate(() => window.fixtureSessionProject?.bindings() ?? {});
}

test('SC-01: a stale membership editor conflicts, keeps its selection and retries on the fresh revision', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical&sessionProject=bound');
  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');

  // Unassociated first association: the read model's 0 token is the CAS
  // precondition, not an omitted expected_revision.
  await focusRow(page, UNBOUND_ID);
  await openEditor(page, UNBOUND_ID);
  await chooseProject(page, 'Nession');
  await page.getByTestId('session-project-save').click();
  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');
  await expect.poll(() => setRequests(page)).toEqual([
    {
      session_id: UNBOUND_ID,
      project_id: PROJECT_ONE,
      expected_revision: 0,
    },
  ]);

  // A opens the bound Session's editor at revision 1 and picks Ops notes.
  await focusRow(page, BOUND_ID);
  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');
  await openEditor(page, BOUND_ID);
  await chooseProject(page, 'Ops notes');

  // B commits a removal from its own valid observation before A saves.
  await page.evaluate(
    (id) => window.fixtureSessionProject?.simulateRemoteChange(id, null),
    BOUND_ID,
  );
  await page.getByTestId('session-project-save').click();

  await expect(page.locator(CONFLICT)).toBeVisible();
  await expect(page.locator(CONFLICT)).toContainText('Another change was saved first');
  // A's intended selection survives, and B's committed removal is unchanged.
  await expect(page.getByTestId('session-project-selected')).toHaveText('Ops notes');
  await expect.poll(() => bindings(page)).toMatchObject({ [BOUND_ID]: null });

  // The conflict reply carried the current token, so the intentional retry
  // commits instead of replaying the stale revision.
  await page.getByTestId('session-project-save').click();
  await expect(page.getByTestId('session-project-chip')).toHaveText('Ops notes');
  await expect.poll(() => bindings(page)).toMatchObject({ [BOUND_ID]: PROJECT_TWO });
  await expect.poll(() => setRequests(page)).toEqual([
    {
      session_id: UNBOUND_ID,
      project_id: PROJECT_ONE,
      expected_revision: 0,
    },
    {
      session_id: BOUND_ID,
      project_id: PROJECT_TWO,
      expected_revision: 1,
    },
    {
      session_id: BOUND_ID,
      project_id: PROJECT_TWO,
      expected_revision: 0,
    },
  ]);

  // ABA: A reopens at the new revision 3, then B removes and re-associates.
  // A's held revision must not overwrite the newer association.
  await openEditor(page, BOUND_ID);
  await chooseProject(page, 'Nession');
  await page.evaluate(
    ([id, projectId]) => {
      window.fixtureSessionProject?.simulateRemoteChange(id, null);
      window.fixtureSessionProject?.simulateRemoteChange(id, projectId);
    },
    [BOUND_ID, PROJECT_TWO],
  );
  await page.getByTestId('session-project-save').click();

  await expect(page.locator(CONFLICT)).toBeVisible();
  await expect(page.getByTestId('session-project-selected')).toHaveText('Nession');
  await expect.poll(() => bindings(page)).toMatchObject({ [BOUND_ID]: PROJECT_TWO });

  // Retry at the current token commits A's selection.
  await page.getByTestId('session-project-save').click();
  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');
  const requests = await setRequests(page);
  expect(requests.slice(-2)).toEqual([
    {
      session_id: BOUND_ID,
      project_id: PROJECT_ONE,
      expected_revision: 3,
    },
    {
      session_id: BOUND_ID,
      project_id: PROJECT_ONE,
      expected_revision: 5,
    },
  ]);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: an unassociated Session sent ' +
      'expected_revision=0; an editor pinned at revision 1 saw a visible conflict after ' +
      'another client removed the membership, kept Ops notes, left the removal unchanged, ' +
      'and committed at expected_revision=0; after a remove/reassociate to revision 5 the ' +
      'stale revision-3 save conflicted, preserved Nession, left the newer association ' +
      'unchanged, and committed at expected_revision=5',
  });
});
