'use strict';
// #2487 SC-09: the Agent — the PTY owner — applies the configured fixed
// columns through the existing authorized resize path, creates a new Session
// at that width, keeps an existing Session's width against a differently-sized
// client, clamps an authorized resize to the Session's columns, and does the
// same with no Server in the path (standalone Agent).
//
// The tests use a real isolated tmux server (private socket), the real
// agent WebSocket listener and the real ControlLease. No mock asserts the
// property for itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2487-sc09-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  // The Agent's own runtime test: a client that states a different width is
  // clamped; only rows are applied; the recorded size is the applied one.
  const registry = cargoTests(
    ['--lib', 'session::registry::tests::resize_applies_the_sessions_columns_not_the_requesters'],
    300000,
  );
  assertRan(registry, [
    'session::registry::tests::resize_applies_the_sessions_columns_not_the_requesters',
  ]);

  // A created Session uses the configured width; a second client cannot
  // reflow it; a lease-holding resize changes rows only.
  const created = cargoTests(
    ['--test', 'integration',
      'server::integration_new_session_uses_configured_columns_and_clamps_resize'],
    300000,
    tmuxEnv,
  );
  assertRan(created, [
    'server::integration_new_session_uses_configured_columns_and_clamps_resize',
  ]);

  // An existing pane keeps its width across an attach; the reply states it.
  const attach = cargoTests(
    ['--test', 'integration',
      'server::integration_attach_keeps_session_columns_and_applies_rows'],
    300000,
    tmuxEnv,
  );
  assertRan(attach, [
    'server::integration_attach_keeps_session_columns_and_applies_rows',
  ]);

  // No Server: the standalone Agent's own configured width is the creation
  // policy and the attach reply states it.
  const standalone = cargoTests(
    ['--test', 'integration',
      'server::integration_standalone_agent_uses_its_configured_columns'],
    300000,
    tmuxEnv,
  );
  assertRan(standalone, [
    'server::integration_standalone_agent_uses_its_configured_columns',
  ]);

  // The mismatch/compatibility policy is not only prose: the Web client adopts
  // the Agent's stated width instead of resending its build value. The unit
  // tests assert the attach-reply parser and the ResizeController adoption.
  const web = require('node:child_process').spawnSync(
    'npm',
    ['--prefix', 'web', 'test', '--', '--project', 'unit',
      'src/product/terminal/__tests__/unit/terminalAgent.test.ts'],
    {
      cwd: path.resolve(__dirname, '../../../../..'),
      encoding: 'utf8',
      timeout: 300000,
      env: { ...process.env, RUSTC_WRAPPER: '' },
    },
  );
  const webOut = String(web.stdout || '') + '\n' + String(web.stderr || '');
  if (web.status !== 0 || !/Tests\s+38 passed/.test(webOut)) {
    throw new Error('the attach-reply compatibility tests did not pass: ' + webOut.slice(-3000));
  }

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + version + ': a real Agent created a new Session at the configured ' +
        'width, kept that width when a second client attached with a different width, and applied only ' +
        'the lease holder\'s rows on resize',
    },
    {
      type: 'runtime',
      value:
        'an existing pane kept its width at attach and the reply stated it; the registry test proved ' +
        'the applied resize is the Session\'s columns with the requested rows',
    },
    {
      type: 'runtime',
      value:
        'a standalone Agent (no Server in the path) used its own configured width for creation and ' +
        'stated it on attach',
    },
    {
      type: 'test',
      value:
        'the Web attach-reply parser accepts the Agent-stated width and ignores malformed values, so a ' +
        'client from a different build adopts the Session rather than resizing it',
    },
  );
  return 'The Agent owns and enforces the Session width through the ControlLease path, including standalone mode; mismatched clients cannot reflow a live Session';
});
