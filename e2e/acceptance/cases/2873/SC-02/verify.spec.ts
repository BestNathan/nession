// #2873 SC-02: A→B→A must keep the third A flight as the owner. B's and the
// first A's completions are stale; the first flight's cleanup must not clear
// the third flight's same-Session guard (a repeat click starts no fourth
// request), and the third flight attaches A. The second test covers a
// same-Session double click: exactly one validation and one attach.
//
// The exact-SHA full-stack runtime supplies the real Server, Agent and tmux;
// reply order is controlled at the page's WebSocket boundary.
import fs from 'node:fs';
import { test } from '@playwright/test';
import { installAttachResponseControl } from '../../../../helpers/attachResponseControl';
import {
  abaKeepsThirdFlightGuard,
  sameSessionDoubleClickStartsOneValidation,
} from '../../../../helpers/attachLatestIntent';
import { waitForShell } from '../../../../helpers/shell';

const runtime = JSON.parse(
  fs.readFileSync(String(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE), 'utf8'),
) as { target_sha: string; profile: string; server_port: number };

function serverUrl(): string {
  return 'ws://127.0.0.1:' + runtime.server_port + '/ws';
}

test.describe('#2873 SC-02 latest-flight guard', () => {
  test.beforeEach(async ({ page }) => {
    await installAttachResponseControl(page);
    await page.goto(
      '/?token=e2e-test-token&server_url=' + encodeURIComponent(serverUrl()),
    );
    await waitForShell(page);
  });

  test('A→B→A keeps the third flight and its guard', async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const evidence = await abaKeepsThirdFlightGuard(page, testInfo);
    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + runtime.target_sha + ': after A, B, A, releasing B\'s and the first ' +
        'A\'s stale replies left A\'s third flight owning the guard (repeat A click kept the ' +
        'attach-request count at A=' + evidence.requestCountA + '), then its release attached A ' +
        'on ' + evidence.route,
    });
  });

  test('A same-Session double click starts one validation and attaches once',
    async ({ page }, testInfo) => {
      test.setTimeout(240_000);
      const evidence = await sameSessionDoubleClickStartsOneValidation(page, testInfo);
      test.info().annotations.push({
        type: 'evidence',
        description:
          'exact SHA ' + runtime.target_sha + ': a double click while the validation was ' +
          'pending produced one attach-info request (A=' + evidence.requestCountA + ') and ' +
          'attached A once on ' + evidence.route,
      });
    });
});
