'use strict';
// #3414 SC-02: a Terminal reference activated from a Session whose CWD is the
// filesystem root resolves against that absolute root. The controlled FileOps
// source holds two distinct entries — filesystem-absolute `/src/foo.rs` and
// source-relative `src/foo.rs` — so a join that treats `/` as the source root
// opens the wrong file, while the correct join opens the absolute target. When
// the absolute target is absent, the same activation must fail visibly instead
// of falling back to the source-relative lookalike.
//
// The stack is the real full-stack runner: real Server, Agent, tmux, P2P
// transport and production Web build. The Session CWD is real too — the Case
// `cd /`s the shell, and the Agent reports `/` exactly as it would for a user
// whose shell sits at the filesystem root. Only the controlled FileOps source
// (`agent.file.list` / `agent.file.read` for these paths) is answered by the
// Case; every other frame, including the P2P handshake and terminal traffic,
// is forwarded to the real Agent.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime,
} = require('../../../shared/foreground-resume-browser.cjs');
const {
  activateReference,
  expectEditorAt,
  expectFilesSurface,
  openAppShell,
  openShell,
  printReference,
  readEditor,
  returnToTerminal,
  runLine,
} = require('../../../shared/terminal-file-links.cjs');

test.setTimeout(110_000);

const ABSOLUTE_LINES = 60;
const RELATIVE_LINES = 60;

function lines(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join('\n') + '\n';
}

const ABSOLUTE_CONTENT = lines('absolute-root-line', ABSOLUTE_LINES);
const RELATIVE_CONTENT = lines('relative-lookalike-line', RELATIVE_LINES);

function directoryEntry(path) {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    full_path: path.startsWith('/') ? path : `/${path}`,
    is_dir: true,
    size: 0,
    modified: 0,
    mime_type: 'inode/directory',
    is_binary: false,
  };
}

function fileEntry(path, content) {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    full_path: path.startsWith('/') ? path : `/${path}`,
    is_dir: false,
    size: Buffer.byteLength(content, 'utf8'),
    modified: 0,
    mime_type: 'text/plain',
    is_binary: false,
  };
}

/**
 * The controlled source's tree. `src` is the source-relative root's `src`
 * directory; `/src` is the filesystem root's. They are deliberately different
 * files with different content, and the lookalike exists even when the
 * absolute target does not, so a losing join is caught by what it opens.
 */
function createControlledSource() {
  const requested = [];
  let absolutePresent = true;

  const lists = () => ({
    '': [directoryEntry('src')],
    src: [fileEntry('src/foo.rs', RELATIVE_CONTENT)],
    '/': [directoryEntry('/src')],
    '/src': [fileEntry('/src/foo.rs', ABSOLUTE_CONTENT)],
  });

  function fileData(path, content, payload) {
    const bytes = Buffer.from(content, 'utf8');
    const offset = Number.isSafeInteger(payload?.offset) ? payload.offset : 0;
    const limit = Number.isSafeInteger(payload?.limit) ? payload.limit : undefined;
    const end = limit === undefined ? bytes.length : Math.min(bytes.length, offset + limit);
    return {
      path,
      content: bytes.subarray(offset, end).toString('base64'),
      mime_type: 'text/plain',
      offset,
      total_size: bytes.length,
      has_more: end < bytes.length,
      revision: 'case-3414-controlled',
    };
  }

  return {
    requested,
    setAbsolutePresent(present) {
      absolutePresent = present;
    },
    /** Reply payload for one request, or `null` to forward to the real Agent. */
    answer(message) {
      if (message?.msg_type === 'agent.file.list') {
        const path = message.payload?.path;
        requested.push({ wire: message.msg_type, path });
        if (path === '/src' && !absolutePresent) {
          return { error: 'not_found: /src (resolved to /src)' };
        }
        const tree = lists();
        if (Object.hasOwn(tree, path)) {
          return { payload: { entries: tree[path] } };
        }
        return { error: `not_found: ${path} (resolved to ${path})` };
      }
      if (message?.msg_type === 'agent.file.read') {
        const path = message.payload?.path;
        requested.push({ wire: message.msg_type, path });
        if (path === '/src/foo.rs') {
          return { payload: fileData(path, ABSOLUTE_CONTENT, message.payload) };
        }
        if (path === 'src/foo.rs') {
          return { payload: fileData(path, RELATIVE_CONTENT, message.payload) };
        }
        return { error: `not_found: ${path} (resolved to ${path})` };
      }
      return null;
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
 * Install the controlled FileOps source on the real Agent transport.
 *
 * Only the browser's P2P Agent socket is routed. Frames the Case does not own
 * are forwarded unchanged, so the Session, terminal, attach and every other
 * capability stay real.
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
        route.send(JSON.stringify(reply(message, outcome)));
      });
    },
  );
}

async function activateAndOpen(page, expect, experience) {
  await runLine(page, expect, 'cd /');
  await printReference(page, expect, 'src/foo.rs:42');
  await activateReference(page, 'src/foo.rs:42');
  await expectFilesSurface(page, expect, experience);
  await expectEditorAt(page, expect, {
    count: 1,
    line: 42,
    column: 1,
    activeLineText: 'absolute-root-line-42',
  });
}

async function activateExpectingFailure(page, expect, experience) {
  await runLine(page, expect, 'cd /');
  await printReference(page, expect, 'src/foo.rs:42');
  await activateReference(page, 'src/foo.rs:42');
  const error = page.getByTestId(
    experience === 'app' ? 'files-app-handoff-error' : 'files-web-handoff-error',
  );
  await expect(error).toBeVisible();
  return error;
}

async function expectAbsoluteTargetOpened(page, expect, source) {
  const editor = await readEditor(page);
  expect(String(editor.text), 'the filesystem-root target is the opened file').toContain(
    'absolute-root-line-42',
  );
  expect(String(editor.text), 'the source-relative lookalike was never opened').not.toContain(
    'relative-lookalike-line',
  );
  expect(
    source.requested.some(
      (entry) => entry.wire === 'agent.file.list' && entry.path === '/src',
    ),
    'the absolute parent directory was listed',
  ).toBe(true);
  expect(
    source.requested.some(
      (entry) => entry.wire === 'agent.file.read' && entry.path === '/src/foo.rs',
    ),
    'the filesystem-root target was read',
  ).toBe(true);
  // The Files surface may enumerate the source-relative tree on its own, so
  // the contract is what the resolver/opener chose, not every listing: the
  // lookalike must never be read as the activated target.
  expect(
    source.requested.some(
      (entry) => entry.wire === 'agent.file.read' && entry.path === 'src/foo.rs',
    ),
    'the source-relative lookalike was never read',
  ).toBe(false);
}

async function expectNoFallback(page, expect, source, mark) {
  const editor = await readEditor(page);
  expect(String(editor.text ?? ''), 'the lookalike content is never shown').not.toContain(
    'relative-lookalike-line',
  );
  const afterFailure = source.requested.slice(mark);
  expect(
    afterFailure.some(
      (entry) => entry.wire === 'agent.file.list' && entry.path === '/src',
    ),
    'the failed activation still resolved against the filesystem root',
  ).toBe(true);
  expect(
    afterFailure.some(
      (entry) => entry.wire === 'agent.file.read' && entry.path === 'src/foo.rs',
    ),
    'the absent absolute target did not read the relative lookalike',
  ).toBe(false);
}

async function runExperience(browser, runtime, experience) {
  const source = createControlledSource();
  const context = await browser.newContext({
    viewport: experience === 'app' ? { width: 390, height: 844 } : { width: 1180, height: 900 },
  });
  await installControlledSource(context, runtime, source);
  const page = await context.newPage();
  try {
    if (experience === 'app') {
      await openAppShell(page, expect, runtime, 'sc02-app');
    } else {
      await openShell(page, expect, runtime, 'sc02-web');
    }

    await activateAndOpen(page, expect, experience);
    await expectAbsoluteTargetOpened(page, expect, source);

    await returnToTerminal(page, expect, experience);
    const negativeMark = source.requested.length;
    source.setAbsolutePresent(false);
    const error = await activateExpectingFailure(page, expect, experience);
    await expect(error).toContainText('/src/foo.rs');
    await expect(error).toContainText('moved or deleted');
    await expectNoFallback(page, expect, source, negativeMark);

    return {
      experience,
      listedAbsolute: source.requested.some(
        (entry) => entry.wire === 'agent.file.list' && entry.path === '/src',
      ),
      readAbsolute: source.requested.some(
        (entry) => entry.wire === 'agent.file.read' && entry.path === '/src/foo.rs',
      ),
    };
  } finally {
    await context.close();
  }
}

test('SC-02: filesystem-root CWD opens the absolute target, never the relative lookalike (Web)', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-02');
  const result = await runExperience(browser, runtime, 'web');
  expect(result.listedAbsolute).toBe(true);
  expect(result.readAbsolute).toBe(true);
  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web Session CWD / listed /src, opened /src/foo.rs ' +
      '(absolute-root-line-42) and read it; the source-relative src/foo.rs was never ' +
      'read or opened; with /src absent the activation failed with /src/foo.rs ' +
      '"moved or deleted" instead of opening the relative lookalike',
  });
});

test('SC-02: filesystem-root CWD opens the absolute target, never the relative lookalike (App)', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-02');
  const result = await runExperience(browser, runtime, 'app');
  expect(result.listedAbsolute).toBe(true);
  expect(result.readAbsolute).toBe(true);
  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': emulated App Session CWD / listed /src, opened /src/foo.rs ' +
      '(absolute-root-line-42) and read it; the source-relative src/foo.rs was never ' +
      'read or opened; with /src absent the activation failed with /src/foo.rs ' +
      '"moved or deleted" instead of opening the relative lookalike',
  });
});
