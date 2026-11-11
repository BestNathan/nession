'use strict';
// SC-05: an OS-managed Agent is not raced by the CLI.
//
// This Case observes a real user service manager. It never creates, unloads or
// signals the operator's services on a shared host: a Pass requires the
// approved native runner to provide an *isolated* user/manager (the runner
// sets NESION_ACCEPTANCE_ISOLATED_SERVICE_MANAGER=1). Without that lane the
// criterion is Pending with the exact missing condition, as the Issue allows.
// A generated unit/plist fixture is not accepted as evidence.
const { execFileSync } = require('node:child_process');
const { assert, fs, path, targetSha, nessionBin, cliOutput } = require('../../../shared/release-hardening-cases.cjs');

const LABEL = 'com.nession.agent';
const UNIT = 'nession-agent.service';

function tryExec(command, args) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (error) {
    return {
      ok: false,
      status: typeof error.status === 'number' ? error.status : null,
      stdout: String(error.stdout || '') + String(error.stderr || ''),
    };
  }
}

function probe() {
  if (process.platform === 'darwin') {
    const uid = process.getuid();
    const plist = path.join(process.env.HOME || '', 'Library/LaunchAgents', LABEL + '.plist');
    const print = tryExec('launchctl', ['print', 'gui/' + uid + '/' + LABEL]);
    const running = print.ok && /^\s*state = running\s*$/m.test(print.stdout);
    const pid = print.ok ? Number((/^\s*pid = (\d+)\s*$/m.exec(print.stdout) || [])[1] || 0) : 0;
    return {
      manager: 'launchd',
      registered: print.ok || fs.existsSync(plist),
      running,
      pid,
      detail: 'launchctl print gui/' + uid + '/' + LABEL + ' -> ' +
        (print.ok ? (running ? 'running pid ' + pid : 'loaded') : 'not loaded') +
        '; plist ' + (fs.existsSync(plist) ? 'present' : 'absent'),
    };
  }
  if (process.platform === 'linux') {
    const show = tryExec('systemctl', [
      '--user', 'show', '--property=ActiveState', '--property=MainPID', '--value', UNIT,
    ]);
    const unitPath = path.join(process.env.HOME || '', '.config/systemd/user', UNIT);
    const lines = show.ok ? show.stdout.trim().split('\n') : [];
    const running = lines.includes('active');
    const pid = Number(lines.find((line) => /^\d+$/.test(line)) || 0);
    return {
      manager: 'systemd',
      registered: show.ok || fs.existsSync(unitPath),
      running,
      pid,
      detail: 'systemctl --user show ' + UNIT + ' -> ' +
        (show.ok ? lines.join(', ') : 'unavailable') +
        '; unit ' + (fs.existsSync(unitPath) ? 'present' : 'absent'),
    };
  }
  return { manager: 'unsupported', registered: false, running: false, pid: 0, detail: process.platform };
}

function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

(async () => {
  const observed = probe();
  const evidence = [{ type: 'runtime', value: observed.detail }];

  if (!observed.registered) {
    return emit({
      status: 'pending',
      summary: 'No registered native Agent service exists on this runner; a real manager-owned '
        + 'process cannot be observed without creating one on the shared host. ' + observed.detail,
      evidence,
    });
  }
  if (process.env.NESION_ACCEPTANCE_ISOLATED_SERVICE_MANAGER !== '1') {
    return emit({
      status: 'pending',
      summary: 'A native Agent service is registered, but this runner did not declare an '
        + 'isolated user/manager lane (NESION_ACCEPTANCE_ISOLATED_SERVICE_MANAGER=1). The Case '
        + 'does not risk stopping an operator-owned process.',
      evidence,
    });
  }

  // The isolated lane owns this manager and process. Prove the CLI defers.
  const sha = targetSha();
  nessionBin();
  const before = observed.pid;
  const stop = cliOutput(['agent', 'stop'], process.env, 30_000);
  assert.notEqual(stop.status, 0, 'CLI stop must refuse a manager-owned Agent');
  assert.match(stop.output, /managed by (systemd|launchd)/);
  evidence.push({ type: 'runtime', value: 'agent stop refused with the manager ownership diagnostic' });
  if (before > 0) {
    assert.ok(isRunning(before), 'the manager-owned Agent was signalled');
    evidence.push({ type: 'runtime', value: 'manager-owned PID ' + before + ' survived the refusal' });
  }
  const start = cliOutput(['agent', 'start'], process.env, 30_000);
  if (start.status === 0) {
    assert.match(start.output, /already running/i);
  } else {
    assert.match(start.output, /managed by (systemd|launchd)/);
  }
  evidence.push({ type: 'runtime', value: 'agent start was idempotent or refused; it did not create a second process' });
  if (before > 0) {
    assert.ok(isRunning(before), 'the manager-owned Agent disappeared after start');
  }
  const after = probe();
  assert.equal(after.pid, before, 'the manager-owned process changed');
  evidence.push({ type: 'runtime', value: 'manager PID stayed ' + before + ' through both commands' });

  return emit({
    status: 'pass',
    summary: 'The isolated native manager owns the Agent; CLI stop/start did not race it or revive '
      + 'another release (exact SHA ' + sha + ')',
    evidence,
  });
})().catch((error) => {
  emit({
    status: 'fail',
    summary: String(error && error.stack ? error.stack : error).slice(-4400),
    evidence: [{ type: 'runtime', value: 'the native manager observations did not establish the criterion' }],
  });
  process.exitCode = 1;
});

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
