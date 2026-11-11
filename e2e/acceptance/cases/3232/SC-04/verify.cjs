'use strict';
// SC-04: an interrupted archive transaction is recoverable and never a release.
//
// The checked-in debug CLI exposes test-only fault injection at the three
// mutation phases (staging, state-move, binary-swap). Each phase is exercised
// twice:
//   - a reported failure, which the transaction rolls back immediately;
//   - a forced abort (SIGABRT), which leaves the durable journal for the next
//     CLI invocation to recover.
// A corrupt journal must fail every command closed instead of starting a
// half-installed release.
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  writeFakeInstall, makeReleaseTarball, startReleaseServer, installEnv,
  runCliAsync, main,
} = require('../../../shared/release-hardening-cases.cjs');

const OLD = '0.35.0';
const TARGET = '1.2.0';
const BINARIES = ['nession', 'nession-agent', 'nession-server'];

function outputOf(result) {
  return String(result.stdout || '') + String(result.stderr || '');
}

function sandbox(base, label) {
  const installDir = path.join(base, label + '-install');
  writeFakeInstall(installDir, OLD);
  const home = mkdirPrivate(path.join(base, label + '-home'));
  fs.mkdirSync(path.join(home, 'server'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, 'server/server.db'), 'old-db');
  fs.writeFileSync(path.join(home, 'agent/identity'), 'old-agent');
  fs.writeFileSync(path.join(home, 'agent-config.toml'), 'old-agent-config');
  fs.writeFileSync(path.join(home, 'server-config.toml'), [
    'listen_address = "127.0.0.1:19094"',
    'db_path = "' + path.join(home, 'server/server.db') + '"',
    'image_blob_dir = "' + path.join(home, 'server/images/blobs') + '"',
    'image_build_dir = "' + path.join(home, 'server/images/build') + '"',
    '',
  ].join('\n'));
  const runtime = mkdirPrivate(path.join(base, label + '-runtime'));
  return {
    installDir,
    home,
    runtime,
    oldBinary: fs.readFileSync(path.join(installDir, 'nession'), 'utf8'),
    config: fs.readFileSync(path.join(home, 'server-config.toml'), 'utf8'),
    env: installEnv({ home, installDir, runtimeDir: runtime }),
  };
}

function assertOldIntact(sandboxState, label) {
  for (const name of BINARIES) {
    assert.equal(
      fs.readFileSync(path.join(sandboxState.installDir, name), 'utf8'),
      sandboxState.oldBinary,
      label + ': Current binary ' + name + ' changed',
    );
  }
  assert.equal(
    fs.readFileSync(path.join(sandboxState.home, 'server/server.db'), 'utf8'),
    'old-db',
    label + ': Current database was not restored',
  );
  assert.equal(
    fs.readFileSync(path.join(sandboxState.home, 'agent/identity'), 'utf8'),
    'old-agent',
    label + ': Current agent state was not restored',
  );
  assert.equal(
    fs.readFileSync(path.join(sandboxState.home, 'agent-config.toml'), 'utf8'),
    'old-agent-config',
  );
  assert.equal(
    fs.readFileSync(path.join(sandboxState.home, 'server-config.toml'), 'utf8'),
    sandboxState.config,
    label + ': the original server config text was not restored',
  );
  assert.ok(
    !fs.existsSync(path.join(sandboxState.home, 'versions', OLD)),
    label + ': a rolled-back archive remains visible',
  );
  assert.ok(
    !fs.existsSync(path.join(sandboxState.home, '.install-transaction.json')),
    label + ': the journal was not cleared after recovery',
  );
}

async function install(sandboxState, release, extraEnv, label) {
  return runCliAsync(
    ['install', TARGET, '--yes'],
    { ...sandboxState.env, NESSION_UPDATE_API_URL: release.base, ...extraEnv },
    60_000,
    label,
  );
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];
  const base = makeRoot('sc04-transaction');
  const releaseTarball = makeReleaseTarball(base, TARGET);
  const release = await startReleaseServer({
    [TARGET]: { ...releaseTarball, checksum: releaseTarball.checksum },
  });

  try {
    for (const phase of ['staging', 'state-move', 'binary-swap']) {
      // 1. Reported failure: the in-process rollback restores the old tree.
      const failed = sandbox(base, phase + '-fail');
      const result = await install(failed, release, { NESSION_INSTALL_FAULT: phase }, phase + ' fault');
      assert.notEqual(result.status, 0, phase + ' fault unexpectedly succeeded: ' + outputOf(result));
      assert.match(outputOf(result), new RegExp('injected install failure at phase .' + phase));
      assertOldIntact(failed, phase + ' fault');
      const listed = await runCliAsync(['version', 'list'], failed.env, 30_000, phase + ' list');
      assert.equal(listed.status, 0, phase + ' list failed: ' + outputOf(listed));
      assert.match(outputOf(listed), new RegExp('Current: ' + OLD.replaceAll('.', '\\.')));
      evidence.push({
        type: 'runtime',
        value: phase + ' failure rolled back in-process: old Current/config/state intact, no archive or journal',
      });

      // 2. Forced abort: the next CLI invocation recovers the durable journal.
      const crashed = sandbox(base, phase + '-abort');
      const abort = await install(crashed, release, { NESSION_INSTALL_ABORT: phase }, phase + ' abort');
      assert.notEqual(abort.status, 0, phase + ' abort unexpectedly succeeded');
      const recovered = await runCliAsync(['version', 'list'], crashed.env, 30_000, phase + ' recover');
      assert.equal(recovered.status, 0, phase + ' recovery failed: ' + outputOf(recovered));
      assertOldIntact(crashed, phase + ' abort');
      assert.match(outputOf(recovered), new RegExp('Current: ' + OLD.replaceAll('.', '\\.')));
      evidence.push({
        type: 'runtime',
        value: phase + ' abort left a journal; the next version list recovered to the old Current without a runnable partial archive',
      });

      // 3. The recovered tree still installs the target release.
      const completed = await install(crashed, release, {}, phase + ' retry');
      assert.equal(completed.status, 0, phase + ' retry failed: ' + outputOf(completed));
      for (const name of BINARIES) {
        assert.match(
          fs.readFileSync(path.join(crashed.installDir, name), 'utf8'),
          new RegExp('nession ' + TARGET.replaceAll('.', '\\.')),
          phase + ': retry did not install ' + name,
        );
        assert.equal(
          fs.readFileSync(path.join(crashed.home, 'versions', OLD, 'bin', name), 'utf8'),
          crashed.oldBinary,
          phase + ': retry did not archive the old ' + name,
        );
      }
      evidence.push({
        type: 'runtime',
        value: phase + ' recovery left a usable installation; a retry archived ' + OLD + ' and installed ' + TARGET,
      });
    }

    // 4. An unreadable journal fails every command closed.
    const corrupt = sandbox(base, 'corrupt');
    fs.writeFileSync(path.join(corrupt.home, '.install-transaction.json'), '{not valid json');
    const refused = await runCliAsync(['version', 'list'], corrupt.env, 30_000, 'corrupt journal');
    assert.notEqual(refused.status, 0, 'a corrupt journal must fail the CLI');
    assert.match(outputOf(refused), /unreadable/);
    assert.ok(fs.existsSync(path.join(corrupt.home, '.install-transaction.json')));
    fs.rmSync(path.join(corrupt.home, '.install-transaction.json'));
    const recoveredCorrupt = await runCliAsync(['version', 'list'], corrupt.env, 30_000, 'manual repair');
    assert.equal(recoveredCorrupt.status, 0, 'removing the journal must restore service');
    evidence.push({
      type: 'runtime',
      value: 'a corrupt journal refused version list with an explicit diagnostic and kept the journal for repair',
    });
  } finally {
    await release.close();
  }

  return {
    summary: 'archive-copy, state-move and binary-swap failures/aborts restore the old release; '
      + 'partial archives are never runnable and recovery errors are explicit (exact SHA ' + sha + ')',
    evidence,
  };
});
