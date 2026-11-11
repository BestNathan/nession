// #2873 SC-01: with A's attach-profile validation pending, selecting B and
// resolving B first must keep B selected, routed and terminal-bound even when
// A's older reply resolves afterwards. The second test covers the dialog
// outcome: a stale resolution to AttachDialog must not open over B.
//
// The exact-SHA full-stack runtime supplies the real Server, Agent and tmux.
// Reply order is controlled at the page's WebSocket boundary; the app's real
// attach flow, selection atom and router run unchanged.
import fs from 'node:fs';
import { test } from '@playwright/test';
import { installAttachResponseControl } from '../../../../helpers/attachResponseControl';
import {
  staleAttachReplyKeepsNewerSelection,
  staleDialogDoesNotOpenOverNewerSelection,
} from '../../../../helpers/attachLatestIntent';
import { waitForShell } from '../../../../helpers/shell';

const runtime = JSON.parse(
  fs.readFileSync(String(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE), 'utf8'),
) as { target_sha: string; profile: string; server_port: number };

function serverUrl(): string {
  return 'ws://127.0.0.1:' + runtime.server_port + '/ws';
}

test.describe('#2873 SC-01 latest-intent attach ownership', () => {
  test.beforeEach(async ({ page }) => {
    await installAttachResponseControl(page);
    await page.goto(
      '/?token=e2e-test-token&server_url=' + encodeURIComponent(serverUrl()),
    );
    await waitForShell(page);
  });

  test('A stale attach reply cannot replace the newer Session selection',
    async ({ page }, testInfo) => {
      test.setTimeout(300_000);
      const evidence = await staleAttachReplyKeepsNewerSelection(page, testInfo);
      test.info().annotations.push({
        type: 'evidence',
        description:
          'exact SHA ' + runtime.target_sha + ': with A pending, B resolved first and ' +
          'attached; A\'s older reply then resolved and the route stayed ' + evidence.route +
          ' with B\'s row selected, the terminal surface live and no dialog; attach requests ' +
          'A=' + evidence.requestCountA + ' B=' + evidence.requestCountB,
      });
    });

  test('A stale dialog result cannot open over the newer Session',
    async ({ page }, testInfo) => {
      test.setTimeout(300_000);
      const evidence = await staleDialogDoesNotOpenOverNewerSelection(page, testInfo);
      test.info().annotations.push({
        type: 'evidence',
        description:
          'exact SHA ' + runtime.target_sha + ': A\'s stored manual URL was gone, so its ' +
          'parked reply resolved to a dialog request after B had attached; releasing it left B ' +
          'on ' + evidence.route + ' with no dialog and no selection change',
      });
    });
});
