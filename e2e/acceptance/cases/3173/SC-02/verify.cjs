'use strict';
// SC-02: selector precedence and the Current/Archived/Running inventory.
//
// `+<version>` beats NESSION_VERSION beats Current; the selected CLI runs with
// its own version home; selection never changes Current; there is no `version
// use`; and `version list` reports the live process from the shared runtime.
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  runCli, assertCliSucceeds, spawnOrphaned, waitFor, waitForGone,
  freePort, waitForTcp, serverConfig, writeFakeInstall, writeArchivedCli,
  installEnv, cliOutput, main,
} = require('../../../shared/release-version-cases.cjs');

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];

  const base = makeRoot('sc02-select');
  const home = mkdirPrivate(path.join(base, 'home'));
  const installDir = path.join(base, 'install');
  const runtime = path.join(base, 'runtime');
  writeFakeInstall(installDir, '1.1.0');
  writeArchivedCli(home, '0.34.0');
  writeArchivedCli(home, '0.30.0');
  const env = installEnv({ home, installDir, runtimeDir: runtime });

  // 1. The inventory distinguishes Current and Archived.
  const listed = assertCliSucceeds(runCli(['version', 'list'], env), 'version list');
  assert.match(listed.stdout, /Current: 1\.1\.0/);
  assert.match(listed.stdout, /Archived: 0\.30\.0, 0\.34\.0/);
  assert.match(listed.stdout, /agent: not running/);
  assert.match(listed.stdout, /server: not running/);
  evidence.push({
    type: 'runtime',
    value: 'version list: Current 1.1.0, Archived 0.30.0 and 0.34.0, Running agent/server not running',
  });

  // 2. `+<version>` selects the archived CLI and its version home.
  const plus = assertCliSucceeds(
    runCli(['+0.34.0', 'config', 'show'], env), 'plus selector');
  assert.match(plus.stdout, /SELECTED 0\.34\.0/);
  assert.match(plus.stdout, /versions\/0\.34\.0/);
  assert.match(plus.stdout, /ARGS: config show/);
  evidence.push({
    type: 'runtime',
    value: '`+0.34.0 config show` ran the archived CLI with NESSION_HOME=' +
      home + '/versions/0.34.0 and argv `config show`',
  });

  // 3. NESSION_VERSION selects too, and `+v` wins over it.
  const envSelected = assertCliSucceeds(
    runCli(['config', 'show'], { ...env, NESSION_VERSION: '0.30.0' }),
    'environment selector');
  assert.match(envSelected.stdout, /SELECTED 0\.30\.0/);
  assert.match(envSelected.stdout, /versions\/0\.30\.0/);
  const precedence = assertCliSucceeds(
    runCli(['+0.34.0', 'config', 'show'], { ...env, NESSION_VERSION: '0.30.0' }),
    'plus over environment');
  assert.match(precedence.stdout, /SELECTED 0\.34\.0/);
  evidence.push({
    type: 'runtime',
    value: 'NESSION_VERSION=0.30.0 selected 0.30.0; `+0.34.0` won over the environment selector',
  });

  // 4. An invalid selector errors; selection never mutates Current.
  const invalid = cliOutput(['config', 'show'], { ...env, NESSION_VERSION: 'latest' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.output, /invalid release version/);
  const after = assertCliSucceeds(runCli(['version', 'list'], env), 'version list after selection');
  assert.match(after.stdout, /Current: 1\.1\.0/);
  evidence.push({
    type: 'runtime',
    value: 'invalid NESSION_VERSION failed without mutation; Current stayed 1.1.0',
  });

  // 5. There is no `version use`.
  const use = cliOutput(['version', 'use', '0.35.0'], env);
  assert.notEqual(use.status, 0, 'version use must not exist');
  evidence.push({
    type: 'runtime',
    value: '`nession version use` exited ' + use.status + ' (no use command)',
  });

  // 6. Running is the actual shared-runtime process and its recorded release.
  const serverHome = mkdirPrivate(path.join(base, 'server-home'));
  const serverPort = await freePort();
  const configFile = serverConfig(path.join(base, 'server-config'), serverPort);
  const serverEnv = installEnv({ home: serverHome, installDir, runtimeDir: runtime });
  assertCliSucceeds(
    runCli(['server', 'start', '--config', configFile], serverEnv, 60_000),
    'start the running component');
  try {
    await waitForTcp(serverPort);
    const running = assertCliSucceeds(runCli(['version', 'list'], env), 'version list with running server');
    assert.match(running.stdout, /server: release 0\.35\.0 \(PID \d+/);
    assert.match(running.stdout, /agent: not running/);
    evidence.push({
      type: 'runtime',
      value: 'version list reported Running server release 0.35.0 from the shared runtime identity',
    });
  } finally {
    assertCliSucceeds(runCli(['server', 'stop'], serverEnv), 'stop the running component');
  }

  return {
    summary: 'Selection precedence, archived home routing, no version use, unchanged Current and ' +
      'Current/Archived/Running inventory (exact SHA ' + sha + ')',
    evidence,
  };
});
