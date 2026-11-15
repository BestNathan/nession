'use strict';
// #3562 SC-02: the Files viewer must not present a document assembled from two
// different on-disk revisions as successfully completed content, and Retry must
// perform a fresh read. The stack is the real full-stack runner (Server, Agent,
// tmux, production Web build); only the `agent.file.list` / `agent.file.read`
// frames for the controlled path are answered by the Case, so the viewer's own
// chunked loader, error surface and Retry control are the production ones.
//
// The directory entry is above the 10 MB chunked threshold, which makes the
// viewer take its chunked path. The first read is held so the Case can observe
// the existing Cancel-owned loading state. Releasing it returns revision A; the
// immediately following read returns revision B with the same length, so only
// the revision guard can reject the splice. Retry then serves one stable
// revision and the assembled document is shown.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  activateReference,
  openShell,
  printReference,
  runLine,
} = require('../../../shared/terminal-file-links.cjs');

test.setTimeout(110_000);

const BIG_FILE_BYTES = 11 * 1024 * 1024;
const PATH = '/sc02-big.txt';
const A_FIRST = 'SC02-A-CONTENT';
const B_SECOND = 'SC02-B-CONTENT';
const STABLE_FIRST = 'SC02-RELOADED';
const STABLE_SECOND = '-CONTENT';
const CHANGED = 'changed while it was being read';

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function fileEntry(path, size) {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    full_path: path,
    is_dir: false,
    size,
    modified: 0,
    mime_type: 'text/plain',
    is_binary: false,
  };
}

/**
 * The controlled source. `conflict` answers the first two chunks from different
 * revisions; `stable` answers both from one revision. The first read can be
 * held so the test observes the chunked loading state without a timing guess.
 */
function createControlledSource() {
  return {
    phase: 'conflict',
    holdFirstRead: true,
    holding: null,
    reads: [],
    answer(message, released = false) {
      if (message?.msg_type === 'agent.file.list') {
        if (message.payload?.path === '/') {
          return { payload: { entries: [fileEntry(PATH, BIG_FILE_BYTES)] } };
        }
        return { error: `not_found: ${message.payload?.path}` };
      }
      if (
        message?.msg_type !== 'agent.file.read' ||
        message.payload?.path !== PATH
      ) {
        return null;
      }
      const offset = message.payload?.offset ?? 0;
      this.reads.push({ offset, phase: this.phase });
      if (this.holdFirstRead && !released) {
        this.holdFirstRead = false;
        return 'hold';
      }
      const first = this.phase === 'conflict' ? A_FIRST : STABLE_FIRST;
      const second = this.phase === 'conflict' ? B_SECOND : STABLE_SECOND;
      return {
        payload: {
          path: PATH,
          content: base64(offset === 0 ? first : second),
          mime_type: 'text/plain',
          offset,
          total_size: Buffer.byteLength(first + second, 'utf8'),
          has_more: offset === 0,
          // Same-length A->B replacement: a size-only check cannot catch it.
          revision: this.phase === 'conflict' ? (offset === 0 ? 'rev-a' : 'rev-b') : 'rev-stable',
        },
      };
    },
  };
}

function reply(message, outcome) {
  if (outcome.error) {
    return {
      msg_type: 'error',
      id: message.id,
      timestamp: Date.now(),
      payload: { code: outcome.error.split(':')[0], message: outcome.error },
    };
  }
  return { msg_type: 'ok', id: message.id, timestamp: Date.now(), payload: outcome.payload };
}

/**
 * Install the controlled FileOps source on the real P2P Agent socket. Every
 * frame the Case does not own is forwarded to the real Agent, so the Session,
 * terminal, attach and the rest of the stack stay real.
 */
async function installControlledSource(context, runtime, source) {
  await context.routeWebSocket(
    new RegExp(`^ws://127\\.0\\.0\\.1:${runtime.agent_port}/ws(?:[?#].*)?$`),
    (route) => {
      const server = route.connectToServer();
      route.onMessage((raw) => {
        if (typeof raw !== 'string') {
          server.send(raw);
          return;
        }
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          server.send(raw);
          return;
        }
        const outcome = source.answer(message);
        if (outcome === null) {
          server.send(raw);
          return;
        }
        if (outcome === 'hold') {
          source.holding = { route, message };
          return;
        }
        route.send(JSON.stringify(reply(message, outcome)));
      });
    },
  );
}

test('SC-02: a revision-conflicted chunked read is an error, not mixed content, and Retry reloads', async ({
  page,
}) => {
  const { runtime, sha } = verifiedRuntime('SC-02');
  const source = createControlledSource();
  await installControlledSource(page.context(), runtime, source);

  await openShell(page, expect, runtime, 'sc02');
  await runLine(page, expect, 'cd /');
  await printReference(page, expect, PATH);
  await activateReference(page, PATH);

  // The Files surface opened and the chunked loader is waiting on its first
  // read: the existing Cancel-owned loading state is visible, and no document
  // has been published.
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect.poll(() => Boolean(source.holding)).toBe(true);

  // Release chunk A; the next request is answered from revision B.
  const held = source.holding;
  source.holding = null;
  held.route.send(
    JSON.stringify(reply(held.message, source.answer(held.message, true))),
  );

  await expect(page.getByText(new RegExp(CHANGED, 'i'))).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(A_FIRST);
  await expect(page.locator('body')).not.toContainText(B_SECOND);
  expect(source.reads.some((read) => read.offset > 0)).toBe(true);

  // Retry is the viewer's fresh read: one stable revision now completes.
  source.phase = 'stable';
  const readsBeforeRetry = source.reads.length;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.cm-content')).toContainText(STABLE_FIRST + STABLE_SECOND, {
    timeout: 20_000,
  });
  await expect(page.getByText(new RegExp(CHANGED, 'i'))).toHaveCount(0);
  await expect(page.locator('.cm-content')).not.toContainText(A_FIRST);
  await expect(page.locator('.cm-content')).not.toContainText(B_SECOND);
  expect(source.reads.slice(readsBeforeRetry).every((read) => read.phase === 'stable')).toBe(
    true,
  );

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' +
      sha +
      ': a chunked Files load over a controlled FileOps source crossed revisions A->B ' +
      '(equal length); the viewer showed the changed-while-read error with Retry and ' +
      'published neither the mixed document nor either chunk, while the chunked loading ' +
      'state kept its Cancel control; Retry issued a fresh read and rendered the stable ' +
      'revision',
  });
});
