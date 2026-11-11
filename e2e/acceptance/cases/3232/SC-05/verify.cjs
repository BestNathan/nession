'use strict';
// SC-05: an OS-managed Agent is not raced by the CLI.
//
// The Case observes a real user service manager. On a disposable GitHub Actions
// runner (`GITHUB_ACTIONS=true`) it provisions an isolated service with the
// real `nession agent install-service`, runs the guard assertions against that
// manager-owned process, and cleans the unit/job up. On a shared developer host
// it never creates or signals a service: a Pass there requires an already
// registered isolated lane (NESION_ACCEPTANCE_ISOLATED_SERVICE_MANAGER=1).
// Without either lane the criterion stays Pending with the exact missing
// condition, as the Issue permits. A generated unit/plist fixture alone is not
// evidence.
const { execFileSync, spawnSync } = require('node:child_process');
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  freePort, cliOutput,
} = require('../../../shared/release-hardening-cases.cjs');

const LABEL = 'com.nession.agent';
const UNIT = 'nession-agent.service';
const ISOLATED_FLAG = 'NESION_ACCEPTANCE_ISOLATED_SERVICE_MANAGER';

function run(command, args, env, timeout = 30_000) {
  return spawnSync(command, args, {
    env: env || process.env,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryRun(command, args, env, timeout) {
  try {
    const result = run(command, args, env, timeout);
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: String(result.stdout || '') + String(result.stderr || ''),
    };
  } catch (error) {
    return { ok: false, status: null, stdout: String(error) };
  }
}

function probe(env) {
  if (process.platform === 'darwin') {
    const uid = process.getuid();
    const plist = path.join(env.HOME || '', 'Library/LaunchAgents', LABEL + '.plist');
    const print = tryRun('launchctl', ['print', 'gui/' + uid + '/' + LABEL], env);
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
    const unitPath = path.join(env.HOME || '', '.config/systemd/user', UNIT);
    const show = tryRun('systemctl', [
      '--user', 'show',
      '--property=LoadState', '--property=ActiveState', '--property=MainPID',
      '--value', UNIT,
    ], env);
    const lines = show.ok ? show.stdout.trim().split('\n') : [];
    const loadState = (lines[0] || '').trim();
    const activeState = (lines[1] || '').trim();
    const pid = Number((lines[2] || '').trim() || 0);
    // `systemctl show` exits 0 even for an unknown unit; LoadState=not-found is
    // the real "no registration" signal.
    const registered = (show.ok && loadState !== 'not-found') || fs.existsSync(unitPath);
    return {
      manager: 'systemd',
      registered,
      running: activeState === 'active',
      pid,
      detail: 'systemctl --user show ' + UNIT + ' -> LoadState=' +
        (loadState || 'unknown') + ' ActiveState=' + (activeState || 'unknown') +
        ' MainPID=' + pid + '; unit ' + (fs.existsSync(unitPath) ? 'present' : 'absent'),
    };
  }
  return { manager: 'unsupported', registered: false, running: false, pid: 0, detail: process.platform };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for ' + label);
}

function userBusEnv(env) {
  const uid = process.getuid();
  const runtime = '/run/user/' + uid;
  return {
    ...env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + runtime + '/bus',
  };
}

async function ensureLinuxUserBus(env) {
  for (const candidate of [env, userBusEnv(env)]) {
    if (tryRun('systemctl', ['--user', 'show-environment'], candidate).ok) {
      return candidate;
    }
  }
  // The staging workflow already enables lingering; this repeats it for a
  // manual isolated runner and waits for the user bus to appear.
  const user = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
  const uid = process.getuid();
  tryRun('sudo', ['loginctl', 'enable-linger', user], env);
  tryRun('sudo', ['systemctl', 'start', 'user@' + uid + '.service'], env);
  const candidate = userBusEnv(env);
  try {
    await waitFor(
      () => tryRun('systemctl', ['--user', 'show-environment'], candidate).ok,
      15_000,
      'the systemd user bus',
    );
    return candidate;
  } catch {
    return null;
  }
}

function laneRoot(prefix) {
  const root = makeRoot(prefix);
  const durable = mkdirPrivate(path.join(root, 'nession-home'));
  const runtime = mkdirPrivate(path.join(root, 'runtime'));
  const work = mkdirPrivate(path.join(root, 'work'));
  return { root, durable, runtime, work };
}

async function writeAgentConfig(durable, work) {
  const port = await freePort();
  const config = path.join(durable, 'agent-config.toml');
  fs.writeFileSync(config, [
    'agent_id = "acceptance-sc05"',
    'server_url = ""',
    'auth_token = ""',
    'agent_token = "acceptance-sc05"',
    'listen_address = "127.0.0.1:' + port + '"',
    'advertise_address = "127.0.0.1"',
    'disable_address_autodetect = true',
    'default_working_dir = "' + work + '"',
    '',
  ].join('\n'));
  return config;
}

function installAndWait(binary, config, env, evidence, platformLabel) {
  const install = run(binary, ['agent', 'install-service', '--config', config], env, 90_000);
  const output = String(install.stdout || '');
  if (install.status !== 0) {
    throw new Error(platformLabel + ' install-service failed: ' + output);
  }
  evidence.push({
    type: 'runtime',
    value: platformLabel + ' install-service started the Agent under the native manager',
  });
  return output;
}

async function provisionLinux(binary, baseEnv, evidence) {
  const root = laneRoot('sc05-linux');
  try {
    const busEnv = await ensureLinuxUserBus(baseEnv);
    if (!busEnv) {
      fs.rmSync(root.root, { recursive: true, force: true });
      return null;
    }
    const env = {
      ...busEnv,
      NESION_HOME: root.durable,
      NESION_RUNTIME_DIR: root.runtime,
    };
    const config = await writeAgentConfig(root.durable, root.work);
    installAndWait(binary, config, env, evidence, 'Linux systemd-user');
    await waitFor(() => probe(env).running && probe(env).pid > 0, 20_000, 'the managed Agent');
    const cleanup = async () => {
      tryRun('systemctl', ['--user', 'stop', UNIT], env);
      tryRun('systemctl', ['--user', 'disable', UNIT], env);
      fs.rmSync(path.join(env.HOME, '.config/systemd/user', UNIT), { force: true });
      tryRun('systemctl', ['--user', 'daemon-reload'], env);
      tryRun('systemctl', ['--user', 'reset-failed', UNIT], env);
      fs.rmSync(root.root, { recursive: true, force: true });
      await waitFor(() => !probe(env).registered, 10_000, 'the unit cleanup');
    };
    return { env, cleanup };
  } catch (error) {
    fs.rmSync(root.root, { recursive: true, force: true });
    throw error;
  }
}

async function provisionMac(binary, baseEnv, evidence) {
  const root = laneRoot('sc05-macos');
  const home = mkdirPrivate(path.join(root.root, 'home'));
  const env = {
    ...baseEnv,
    HOME: home,
    NESION_HOME: root.durable,
    NESION_RUNTIME_DIR: root.runtime,
  };
  try {
    const config = await writeAgentConfig(root.durable, root.work);
    installAndWait(binary, config, env, evidence, 'macOS launchd');
    await waitFor(() => probe(env).running && probe(env).pid > 0, 20_000, 'the managed Agent');
    const uid = process.getuid();
    const cleanup = async () => {
      tryRun('launchctl', ['bootout', 'gui/' + uid + '/' + LABEL], env);
      tryRun('launchctl', ['enable', 'gui/' + uid + '/' + LABEL], env);
      fs.rmSync(root.root, { recursive: true, force: true });
      await waitFor(() => !probe(env).registered, 10_000, 'the launchd cleanup');
    };
    return { env, cleanup };
  } catch (error) {
    fs.rmSync(root.root, { recursive: true, force: true });
    throw error;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function assertGuard(laneEnv, observed, evidence) {
  const before = observed.pid;
  assert.ok(before > 0, 'the manager-owned Agent reported no PID');
  const stop = cliOutput(['agent', 'stop'], laneEnv, 30_000);
  assert.notEqual(stop.status, 0, 'CLI stop must refuse a manager-owned Agent: ' + stop.output);
  assert.match(stop.output, /managed by (systemd|launchd)/);
  assert.ok(isRunning(before), 'the manager-owned Agent was signalled');
  evidence.push({ type: 'runtime', value: 'agent stop refused with the manager ownership diagnostic' });
  evidence.push({ type: 'runtime', value: 'manager-owned PID ' + before + ' survived the refusal' });

  const start = cliOutput(['agent', 'start'], laneEnv, 30_000);
  if (start.status === 0) {
    assert.match(start.output, /already running/i);
  } else {
    assert.match(start.output, /managed by (systemd|launchd)/);
  }
  assert.ok(isRunning(before), 'the manager-owned Agent disappeared after start');
  evidence.push({
    type: 'runtime',
    value: 'agent start was idempotent or refused; it did not create a second process',
  });

  const after = probe(laneEnv);
  assert.equal(after.pid, before, 'the manager-owned process changed');
  evidence.push({ type: 'runtime', value: 'manager PID stayed ' + before + ' through both commands' });
}

(async () => {
  const observed = probe(process.env);
  const evidence = [{ type: 'runtime', value: observed.detail }];
  const sha = targetSha();

  if (observed.registered) {
    if (process.env[ISOLATED_FLAG] !== '1') {
      return emit({
        status: 'pending',
        summary: 'A native Agent service is registered, but this runner did not declare an '
          + 'isolated user/manager lane (' + ISOLATED_FLAG + '=1). The Case does not risk '
          + 'stopping an operator-owned process.',
        evidence,
      });
    }
    assertGuard(process.env, observed, evidence);
    return emit({
      status: 'pass',
      summary: 'The isolated native manager owns the Agent; CLI stop/start did not race it or '
        + 'revive another release (exact SHA ' + sha + ')',
      evidence,
    });
  }

  // A disposable GitHub Actions runner is the approved isolated lane. It is
  // safe to create and remove a real unit/job there; a shared host is not.
  const disposable = process.env.GITHUB_ACTIONS === 'true';
  let lane = null;
  if (disposable && process.platform === 'linux') {
    lane = await provisionLinux(nessionBin(), process.env, evidence);
  } else if (disposable && process.platform === 'darwin') {
    lane = await provisionMac(nessionBin(), process.env, evidence);
  }
  if (!lane) {
    const condition = disposable
      ? 'The runner did not expose a usable systemd user/launchd manager for an isolated service.'
      : 'No registered native Agent service exists on this shared host and no isolated lane is '
        + 'declared.';
    return emit({
      status: 'pending',
      summary: condition + ' SC-05 stays Pending until the approved isolated native lane runs it.',
      evidence,
    });
  }

  try {
    const managed = probe(lane.env);
    evidence.push({ type: 'runtime', value: managed.detail });
    assert.ok(managed.running, 'the provisioned service is not running');
    assertGuard(lane.env, managed, evidence);
  } finally {
    await lane.cleanup();
  }

  return emit({
    status: 'pass',
    summary: 'A real isolated ' + (process.platform === 'linux' ? 'systemd-user' : 'launchd') +
      ' service owned the Agent; CLI stop/start did not race it and the unit/job was cleaned up '
      + '(exact SHA ' + sha + ')',
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
