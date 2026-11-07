import { expect, type Page, type TestInfo } from '@playwright/test';
import { createSession } from './terminalRegression';
import {
  attachRequestCount,
  holdAttachResponse,
  releaseAttachResponse,
  resetAttachRequestCounts,
  waitForHeldAttach,
  waitForNoPendingAttach,
} from './attachResponseControl';

/**
 * Latest-intent attach scenarios (#2873).
 *
 * One owner for the user-facing interleavings so the regression spec
 * (`session-lifecycle.spec.ts`) and the source-aligned acceptance Cases run
 * the exact same steps. Each scenario asserts through the real UI (selected
 * row, route, terminal surface) while `attachResponseControl` decides the
 * reply order at the transport boundary.
 */

const ATTACH_PROFILE_KEY = 'nession_session_attach_profiles';

type ProfileSeed = {
  sessionId: string;
  mode?: 'auto' | 'relay';
  selectedUrl?: string | null;
};

export interface AttachOrderingEvidence {
  sessionA: string;
  sessionB: string;
  route: string;
  requestCountA: number;
  requestCountB: number;
}

/** Session id from the row's primary control (`session-item-<id>`). */
async function sessionIdFor(page: Page, name: string): Promise<string> {
  const row = page.locator('[data-testid="session-item-row"]', { hasText: name });
  await expect(row).toBeVisible();
  const control = row.locator('button[data-testid^="session-item-"]').first();
  const testId = await control.getAttribute('data-testid');
  if (!testId || !testId.startsWith('session-item-')) {
    throw new Error('session row has no session-id control: ' + name);
  }
  return testId.slice('session-item-'.length);
}

async function seedAttachProfiles(page: Page, seeds: ProfileSeed[]): Promise<void> {
  await page.evaluate(({ key, entries }) => {
    const map: Record<string, unknown> = {};
    for (const entry of entries) {
      map[entry.sessionId] = {
        schemaVersion: 1,
        sessionId: entry.sessionId,
        agentId: entry.sessionId.split(':')[0],
        choice: {
          mode: entry.mode ?? 'auto',
          renderer: 'canvas',
          selectedUrl: entry.selectedUrl ?? null,
        },
        // Auto intent ignores the snapshot fingerprint; this is only a marker.
        optionsFingerprint: 'e2e-2873',
        updatedAt: 1,
      };
    }
    localStorage.setItem(key, JSON.stringify(map));
  }, { key: ATTACH_PROFILE_KEY, entries: seeds });
}

/** The attached Session is the route, the selected row, and a live terminal. */
async function expectAttachedSession(page: Page, sessionId: string): Promise<void> {
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash))
    .toBe(`#/terminal/${sessionId}`);
  await expect(page.getByTestId(`session-item-${sessionId}`))
    .toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-testid="terminal"] .xterm-screen').first())
    .toBeVisible({ timeout: 60_000 });
}

/** After a stale reply lands, the newer Session is still the selection. */
async function expectSelectionUnchanged(page: Page, sessionId: string): Promise<void> {
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(`#/terminal/${sessionId}`);
  await expect(page.getByTestId(`session-item-${sessionId}`))
    .toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function createTwoSessions(
  page: Page,
  testInfo: TestInfo,
): Promise<{ names: [string, string]; ids: [string, string] }> {
  const stamp = `${testInfo.retry}-${Date.now()}`;
  const names: [string, string] = [
    `e2e-attach-race-a-${stamp}`,
    `e2e-attach-race-b-${stamp}`,
  ];
  await createSession(page, names[0]);
  await createSession(page, names[1]);
  const ids: [string, string] = [
    await sessionIdFor(page, names[0]),
    await sessionIdFor(page, names[1]),
  ];
  return { names, ids };
}

/**
 * Session creation opens the attach dialog for a moment, and that dialog
 * fetches attach info of its own. Let those replies land, then start counting
 * from zero so the scenario measures only its own clicks.
 */
async function settleAttachRequests(page: Page): Promise<void> {
  await waitForNoPendingAttach(page);
  await resetAttachRequestCounts(page);
}

async function killSession(page: Page, sessionId: string, name: string): Promise<void> {
  // The row's actions live in the `…` menu in both experiences; the direct
  // "Kill session" button only exists in App. Drive the menu so cleanup works
  // in Web and cannot burn the rest of the test budget.
  const trigger = page.getByTestId(`session-actions-${sessionId}`);
  if (await trigger.count() === 0) { return; }
  await trigger.click({ timeout: 10_000 });
  const item = page.getByTestId(`session-actions-kill-${sessionId}`);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click({ timeout: 10_000 });
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.locator('#kill-confirm-name').fill(name);
  await dialog.getByRole('button', { name: 'Kill Session' }).click({ timeout: 10_000 });
  await expect(
    page.locator('[data-testid="session-item-row"]', { hasText: name }),
  ).toHaveCount(0, { timeout: 15_000 });
}

async function cleanup(
  page: Page,
  ids: [string, string],
  names: [string, string],
  first: 0 | 1,
): Promise<void> {
  await killSession(page, ids[first], names[first]).catch(() => {});
  await killSession(page, ids[1 - first], names[1 - first]).catch(() => {});
}

async function evidenceOf(
  page: Page,
  ids: [string, string],
): Promise<AttachOrderingEvidence> {
  return {
    sessionA: ids[0],
    sessionB: ids[1],
    route: decodeURIComponent(new URL(page.url()).hash),
    requestCountA: await attachRequestCount(page, ids[0]),
    requestCountB: await attachRequestCount(page, ids[1]),
  };
}

/**
 * SC-01: A's reply is parked, B is selected and attached first, then A's
 * older reply is released. The selection must remain B and no dialog may
 * appear.
 */
export async function staleAttachReplyKeepsNewerSelection(
  page: Page,
  testInfo: TestInfo,
): Promise<AttachOrderingEvidence> {
  const { names, ids } = await createTwoSessions(page, testInfo);
  const [a, b] = ids;
  try {
    await seedAttachProfiles(page, [{ sessionId: a }, { sessionId: b }]);
    // Creation's dialog fetched attach info; measure only the clicks below.
    await settleAttachRequests(page);

    await holdAttachResponse(page, a);
    await page.getByTestId(`session-item-${a}`).click();
    await waitForHeldAttach(page, a);

    await holdAttachResponse(page, b);
    await page.getByTestId(`session-item-${b}`).click();
    await waitForHeldAttach(page, b);
    if (!await releaseAttachResponse(page, b)) {
      throw new Error('B attach reply was not parked');
    }
    await expectAttachedSession(page, b);

    if (!await releaseAttachResponse(page, a)) {
      throw new Error('A attach reply was not parked');
    }
    await expectSelectionUnchanged(page, b);
    return await evidenceOf(page, ids);
  } finally {
    await cleanup(page, ids, names, 1);
  }
}

/**
 * SC-01: A's parked reply resolves to an attach dialog (its stored manual URL
 * is gone). That stale dialog must not open over the attached B.
 */
export async function staleDialogDoesNotOpenOverNewerSelection(
  page: Page,
  testInfo: TestInfo,
): Promise<AttachOrderingEvidence> {
  const { names, ids } = await createTwoSessions(page, testInfo);
  const [a, b] = ids;
  try {
    await seedAttachProfiles(page, [
      { sessionId: a, mode: 'relay', selectedUrl: 'ws://127.0.0.1:9/gone' },
      { sessionId: b },
    ]);
    await settleAttachRequests(page);

    await holdAttachResponse(page, a);
    await page.getByTestId(`session-item-${a}`).click();
    await waitForHeldAttach(page, a);

    await holdAttachResponse(page, b);
    await page.getByTestId(`session-item-${b}`).click();
    await waitForHeldAttach(page, b);
    if (!await releaseAttachResponse(page, b)) {
      throw new Error('B attach reply was not parked');
    }
    await expectAttachedSession(page, b);

    if (!await releaseAttachResponse(page, a)) {
      throw new Error('A attach reply was not parked');
    }
    await expectSelectionUnchanged(page, b);
    return await evidenceOf(page, ids);
  } finally {
    await cleanup(page, ids, names, 1);
  }
}

/**
 * SC-02: A → B → A. B's and the first A's replies are stale; flight 1's
 * completion must not clear flight 3's guard (a repeat A click starts no
 * fourth request), and flight 3 attaches A.
 */
export async function abaKeepsThirdFlightGuard(
  page: Page,
  testInfo: TestInfo,
): Promise<AttachOrderingEvidence> {
  const { names, ids } = await createTwoSessions(page, testInfo);
  const [a, b] = ids;
  try {
    await seedAttachProfiles(page, [{ sessionId: a }, { sessionId: b }]);
    // Creation's dialog fetched attach info; measure only the clicks below.
    await settleAttachRequests(page);

    await holdAttachResponse(page, a);
    await holdAttachResponse(page, b);
    await page.getByTestId(`session-item-${a}`).click(); // flight 1 (A)
    await waitForHeldAttach(page, a);
    await page.getByTestId(`session-item-${b}`).click(); // flight 2 (B)
    await waitForHeldAttach(page, b);
    await page.getByTestId(`session-item-${a}`).click(); // flight 3 (A)
    await waitForHeldAttach(page, a, 2);

    if (!await releaseAttachResponse(page, b)) {
      throw new Error('B attach reply was not parked');
    }
    if (!await releaseAttachResponse(page, a)) {
      throw new Error('the first A attach reply was not parked');
    }
    // Flight 1 finished; flight 3 must still own the same-Session guard.
    await page.getByTestId(`session-item-${a}`).click();
    await expect.poll(() => attachRequestCount(page, a)).toBe(2);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    if (!await releaseAttachResponse(page, a)) {
      throw new Error('the third A attach reply was not parked');
    }
    await expectAttachedSession(page, a);
    return await evidenceOf(page, ids);
  } finally {
    await cleanup(page, ids, names, 0);
  }
}

/**
 * SC-02: a same-Session double click while the validation is pending starts
 * exactly one attach-info request and attaches once.
 */
export async function sameSessionDoubleClickStartsOneValidation(
  page: Page,
  testInfo: TestInfo,
): Promise<AttachOrderingEvidence> {
  const { names, ids } = await createTwoSessions(page, testInfo);
  const [a] = ids;
  try {
    await seedAttachProfiles(page, [{ sessionId: a }]);
    await settleAttachRequests(page);

    await holdAttachResponse(page, a);
    await page.getByTestId(`session-item-${a}`).click();
    await page.getByTestId(`session-item-${a}`).click();
    await waitForHeldAttach(page, a);
    await expect.poll(() => attachRequestCount(page, a)).toBe(1);

    if (!await releaseAttachResponse(page, a)) {
      throw new Error('A attach reply was not parked');
    }
    await expectAttachedSession(page, a);
    return await evidenceOf(page, ids);
  } finally {
    await cleanup(page, ids, names, 0);
  }
}
