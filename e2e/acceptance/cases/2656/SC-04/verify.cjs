'use strict';
// #2656 SC-04: the consolidated owner does not regress the Terminal OSC
// 52/5522 protocol, its authorization/replay/observer guards, bounded notices
// or paste handling. Every write delegates to the one shared owner: the
// automatic OSC 52 path attempts the library-backed HTTP legacy copy, while
// the async capability answer stays secure-only.
const fs = require('node:fs');
const path = require('node:path');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const {
  ROOT, readSource, runWebTests,
} = require('../../../shared/p2p-credential-cases.cjs');

function sourceFiles(relativeDir) {
  const start = path.join(ROOT, relativeDir);
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        files.push(path.relative(ROOT, full));
      }
    }
  };
  visit(start);
  return files;
}

run(({ evidence }) => {
  const sha = targetSha();

  // The protocol and its browser bindings still pass at the exact SHA.
  const protocol = runWebTests([
    'src/platform/terminal-runtime/clipboard/__tests__/unit/ClipboardProtocol.test.ts',
  ]);
  const binding = runWebTests([
    'src/platform/terminal-runtime/clipboard/__tests__/integration/XtermClipboardBinding.test.ts',
  ]);
  const controller = runWebTests([
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalControllerClipboard.test.ts',
  ]);
  const gesture = runWebTests([
    'src/platform/terminal-runtime/clipboard/__tests__/integration/BrowserClipboardGesture.test.ts',
  ]);

  // The adapter keeps the protocol-specific MIME/error ownership and delegates
  // every write; it owns no clipboard primitive or second legacy implementation.
  const adapter = readSource(
    'web/src/platform/terminal-runtime/clipboard/browserClipboard.ts',
  );
  for (const required of [
    "from '@/shared/lib/clipboard'",
    'ClipboardWriteError',
    'writeTextProgrammatic',
    'writeClipboardItem',
    'writeClipboard',
    'asyncClipboardWriteAvailable',
  ]) {
    if (!adapter.includes(required)) {
      throw new Error('terminal clipboard adapter lost: ' + required);
    }
  }
  const adapterCode = adapter
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const forbidden of ['navigator.clipboard', 'document.execCommand']) {
    if (adapterCode.includes(forbidden)) {
      throw new Error('the terminal adapter still owns a browser clipboard primitive: ' + forbidden);
    }
  }

  // The shared owner defines the one error vocabulary and both truthful codes.
  const shared = readSource('web/src/shared/lib/clipboard.ts');
  for (const required of [
    'NotAllowedError',
    'SecurityError',
    'isPermissionError',
    'ClipboardWriteError',
    "'EPERM'",
    "'EIO'",
    'asyncClipboardWriteAvailable',
    'writeTextProgrammatic',
    'writeClipboardItem',
  ]) {
    if (!shared.includes(required)) {
      throw new Error('the shared clipboard owner lost: ' + required);
    }
  }

  // Exactly one module integrates the open-source library, and dependency
  // metadata pins it with its license.
  const importers = sourceFiles('web/src').filter((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return /from ['"]copy-to-clipboard['"]/.test(text);
  });
  if (importers.length !== 1 || importers[0] !== 'web/src/shared/lib/clipboard.ts') {
    throw new Error('copy-to-clipboard must have exactly one owner, found: ' + importers.join(', '));
  }
  if (!shared.includes('fallbackToPrompt: false')) {
    throw new Error('the library prompt fallback must stay disabled');
  }
  const pkg = JSON.parse(readSource('web/package.json'));
  const lock = JSON.parse(readSource('web/package-lock.json'));
  const locked = lock.packages['node_modules/copy-to-clipboard'];
  if (pkg.dependencies['copy-to-clipboard'] !== '^4.0.2' ||
      !locked || locked.version !== '4.0.2' || locked.license !== 'MIT') {
    throw new Error('copy-to-clipboard dependency metadata is missing version/license');
  }

  // HTTP must not advertise the async programmatic capability it cannot serve;
  // the shared owner detects it and the adapter consumes that answer, while
  // automatic writes still attempt the shared library's legacy path.
  if (!shared.includes('asyncClipboardWriteAvailable') ||
      !shared.includes('window.isSecureContext === false') ||
      !adapter.includes('asyncClipboardWriteAvailable')) {
    throw new Error('automatic write capability detection was lost');
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': clipboard protocol/controller tests pass (' + protocol +
      ' + ' + binding + ' + ' + controller + ' + ' + gesture + ' tests); the Terminal adapter ' +
      'delegates every write to the single shared owner, which keeps the EPERM/EIO vocabulary ' +
      'and MIME item, integrates copy-to-clipboard (4.0.2, MIT, lockfile-pinned) for text, ' +
      'attempts the HTTP legacy path for automatic OSC 52, and preserves secure-context ' +
      'detection for the async capability answer',
  });
  return (
    'The shared clipboard owner keeps the Terminal protocol, authorization, replay/observer, ' +
    'notice and paste semantics intact, with one lockfile-pinned library integration'
  );
});
