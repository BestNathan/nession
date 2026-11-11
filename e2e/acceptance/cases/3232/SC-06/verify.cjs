'use strict';
// SC-06: SIGKILL re-verifies the process identity first.
//
// SCN-03 for this criterion is a local subprocess with deterministic forged
// timing: a real `sh` process ignores SIGTERM, and a real ProcessIdentity file
// names it. The real `nession agent|server stop` runs the grace period against
// that process. This is not a mock of the stop logic — the production signal
// path is the code under test.
//
//   1. unchanged identity -> the ordinary timeout force-kills the original;
//   2. the identity record changes during the grace period -> no SIGKILL, and
//      the unrelated process survives.
const { execFileSync } = require('node:child_process');
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  runCli, spawnCli, waitFor, waitForGone, waitForExit, isRunning,
  installEnv, readIdentity, writeIdentity, main,
} = require('../../../shared/release-hardening-cases.cjs');

function readOutput(child) {
  return String(child.output || '') + String(child.errors || '');
}

/** Parse `ps -o etime=` -> seconds. */
function elapsedSeconds(text) {
  const value = String(text).trim();
  const days = /^(\d+)-/.exec(value);
  const rest = days ? value.slice(days[0].length) : value;
  const parts = rest.split(':').map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  if (days) seconds += Number(days[1]) * 86_400;
  return seconds;
}

/**
 * A real process that ignores SIGTERM, orphaned so it is never our zombie.
 * Its identity is written from the OS start time, which is exactly what the
 * daemon writer records.
 */
function startTermIgnoringProcess(identityPath, kind) {
  const pid = Number(execFileSync('/bin/sh', [
    '-c',
    "(trap '' TERM; while :; do sleep 1; done) >/dev/null 2>&1 & echo $!",
  ], { encoding: 'utf8' }).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'the helper shell reported no pid');
  const elapsed = elapsedSeconds(
    execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' }),
  );
  const startedAt = Math.floor(Date.now() / 1000) - elapsed;
  writeIdentity(identityPath, { pid, startedAt, kind, version: '0.35.0' });
  return { pid, startedAt };
}

async function positiveTimeout(component, identityPath, env, evidence) {
  const target = startTermIgnoringProcess(identityPath, component);
  const result = runCli([component, 'stop'], env, 30_000);
  const output = String(result.stdout) + String(result.stderr);
  assert.equal(result.status, 0, component + ' stop failed: ' + output);
  assert.match(output, /sending SIGKILL/);
  assert.match(output, /force killed/);
  await waitForGone(target.pid, 5_000, component + ' force kill');
  evidence.push({
    type: 'runtime',
    value: component + ' PID ' + target.pid + ' ignored SIGTERM and was force-killed after the identity re-check',
  });
}

async function changedIdentity(component, identityPath, env, evidence) {
  const target = startTermIgnoringProcess(identityPath, component);
  const stop = spawnCli([component, 'stop'], env);
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
    writeIdentity(identityPath, {
      pid: target.pid,
      startedAt: target.startedAt + 3_600,
      kind: component,
      version: '0.35.0',
    });
    const exit = await waitForExit(stop, 30_000);
    const output = readOutput(stop);
    assert.equal(exit.code, 0, component + ' identity mismatch must be a safe no-op: ' + output);
    assert.match(output, /not sending SIGKILL/);
    assert.ok(isRunning(target.pid), 'a reused ' + component + ' pid was signalled');
    evidence.push({
      type: 'runtime',
      value: component + ' PID ' + target.pid + ' survived: the record described another instance at SIGKILL time',
    });
  } finally {
    if (isRunning(target.pid)) globalThis.process.kill(target.pid, 'SIGKILL');
    await waitForExit(stop, 5_000).catch(() => {});
    await waitForGone(target.pid, 5_000, component + ' cleanup').catch(() => {});
  }
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];
  const base = makeRoot('sc06-identity');
  const runtime = mkdirPrivate(path.join(base, 'runtime'));
  const env = installEnv({ home: mkdirPrivate(path.join(base, 'home')), runtimeDir: runtime });

  const serverIdentity = path.join(runtime, 'server.pid');
  const agentIdentity = path.join(runtime, 'agent.pid');

  await positiveTimeout('server', serverIdentity, env, evidence);
  await changedIdentity('server', serverIdentity, env, evidence);
  await positiveTimeout('agent', agentIdentity, env, evidence);
  await changedIdentity('agent', agentIdentity, env, evidence);

  return {
    summary: 'Agent and Server stop re-verify ProcessIdentity before SIGKILL; a changed identity '
      + 'is never signalled and the ordinary timeout still terminates the original (exact SHA ' + sha + ')',
    evidence,
  };
});
