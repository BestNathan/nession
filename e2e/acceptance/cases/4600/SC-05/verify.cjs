'use strict';
// SC-05 (#4600): real isolated CLI process behavior for logs, startup
// diagnostics and readiness ownership.
//
// Every row uses the exact-SHA CLI binary in its own temporary
// HOME/NESSION_HOME/NESSION_RUNTIME_DIR. No production path, daemon or
// credential is touched. The rows prove:
//   - foreground/background starts keep normal runtime logging and ownership;
//   - malformed config, early validation failure and a readiness failure leave
//     a retrievable sanitized startup diagnostic;
//   - an unusable log directory reports startup capture as unavailable while
//     preserving the terminal/stderr diagnostic;
//   - a child stderr flood (a 100 KB invalid value, above the 64 KiB pipe
//     buffer but below Linux's per-env-string limit) cannot deadlock startup and
//     the durable record stays bounded;
//   - Ctrl-C of `logs -f` stops only the reader, never the daemon.
const {
  assert,
  fs,
  path,
  targetSha,
  makeRoot,
  mkdirPrivate,
  runtimeEnv,
  runCli,
  spawnCli,
  waitFor,
  waitForExit,
  isRunning,
  freePort,
  waitForTcp,
  readIdentity,
  main,
} = require('../../../shared/runtime-directory-cases.cjs');

const net = require('node:net');

const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mustSucceed(result, label) {
  assert.equal(
    result.status,
    0,
    label + ' failed (exit ' + result.status + '): ' +
      String(result.stderr || result.stdout).slice(-3500),
  );
  return result;
}

function mustFail(result, label) {
  assert.notEqual(result.status, 0, label + ' unexpectedly succeeded');
  return String(result.stdout || '') + String(result.stderr || '');
}

function configText({ agentId, serverPort, agentPort, workDir, extra = [] }) {
  return [
    'agent_id = "' + agentId + '"',
    'server_url = "ws://127.0.0.1:' + serverPort + '/ws"',
    'auth_token = ""',
    'listen_address = "127.0.0.1:' + agentPort + '"',
    'advertise_address = "127.0.0.1"',
    'disable_address_autodetect = true',
    'default_working_dir = "' + workDir + '"',
    'tmux_socket_path = "' + path.join(path.dirname(workDir), 'tmux.sock') + '"',
    ...extra,
    '',
  ].join('\n');
}

function serverConfigText({ serverPort, dbPath }) {
  return [
    'listen_address = "127.0.0.1:' + serverPort + '"',
    'tls_cert_path = ""',
    'tls_key_path = ""',
    'auth_token = ""',
    'db_path = "' + dbPath + '"',
    'heartbeat_timeout_secs = 120',
    '',
  ].join('\n');
}

function startupLogs(env) {
  const result = runCli(['agent', 'logs', '--source', 'startup', '-n', '50'], env, 30_000);
  mustSucceed(result, 'agent logs --source startup');
  return String(result.stdout);
}

function startupFile(home) {
  return path.join(home, 'agent', 'logs', 'startup', 'startup.log');
}

function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

main(async () => {
  const sha = targetSha();
  const evidence = [];
  const base = makeRoot('4600-sc05');
  const home = mkdirPrivate(path.join(base, 'home'));
  const runtime = mkdirPrivate(path.join(base, 'runtime'));
  const work = mkdirPrivate(path.join(base, 'work'));
  const env = runtimeEnv({ home, runtimeDir: runtime });
  const serverPort = await freePort();
  const agentPort = await freePort();
  const configFile = path.join(home, 'agent-config.toml');
  const serverConfigFile = path.join(home, 'server-config.toml');
  fs.writeFileSync(
    serverConfigFile,
    serverConfigText({ serverPort, dbPath: path.join(home, 'server', 'server.db') }),
  );
  fs.writeFileSync(
    configFile,
    configText({ agentId: 'acceptance-4600', serverPort, agentPort, workDir: work }),
  );
  mkdirPrivate(path.join(home, 'server'));

  let follower = null;
  let blocker = null;
  let agentStarted = false;
  let serverStarted = false;
  try {
    // 1. A real background Server keeps its runtime log and records its scope.
    mustSucceed(runCli(['server', 'start'], env, 60_000), 'server start');
    serverStarted = true;
    await waitForTcp(serverPort);
    await waitFor(
      () => fs.existsSync(path.join(runtime, 'server.pid')),
      15_000,
      'Server runtime identity',
    );
    const serverIdentity = readIdentity(path.join(runtime, 'server.pid'));
    assert.equal(serverIdentity.home, home, 'the Server identity must record its home');
    assert.equal(
      serverIdentity.log_dir,
      path.join(home, 'server', 'logs'),
      'the Server identity must record its runtime log directory',
    );
    const serverLogs = mustSucceed(runCli(['server', 'logs', '-n', '50'], env), 'server logs');
    assert.match(
      String(serverLogs.stdout),
      /nession-server.*starting|Starting nession-server/,
      'the Server runtime file must hold its startup record: ' + String(serverLogs.stdout),
    );
    const serverStatus = mustSucceed(runCli(['server', 'status'], env), 'server status');
    assert.match(
      String(serverStatus.stdout),
      /Logs: .*server\/logs \(recorded by the running process\)/,
      'status must show the recorded Server log directory: ' + String(serverStatus.stdout),
    );
    evidence.push({
      type: 'runtime',
      value: sha + ': background Server recorded log_dir=' + serverIdentity.log_dir +
        ' home=' + serverIdentity.home + '; server logs/status read that directory',
    });

    // 2. A real background Agent keeps runtime logging and identity scope; a
    //    followed reader cancelled with Ctrl-C does not touch the daemon.
    mustSucceed(runCli(['agent', 'start'], env, 60_000), 'agent start');
    agentStarted = true;
    await waitFor(
      () => fs.existsSync(path.join(runtime, 'agent.pid')),
      15_000,
      'Agent runtime identity',
    );
    const agentIdentity = readIdentity(path.join(runtime, 'agent.pid'));
    assert.equal(agentIdentity.home, home, 'the Agent identity must record its home');
    assert.equal(
      agentIdentity.log_dir,
      path.join(home, 'agent', 'logs'),
      'the Agent identity must record its runtime log directory',
    );
    await waitFor(() => {
      const result = runCli(['agent', 'logs', '-n', '50'], env, 30_000);
      return result.status === 0 && String(result.stdout).includes('nession-agent 1');
    }, 20_000, 'Agent runtime log content');
    const agentLog = mustSucceed(runCli(['agent', 'logs', '--path'], env), 'agent logs --path');
    assert.match(
      String(agentLog.stdout),
      /agent\/logs\/nession-agent/,
      '--path must resolve the Agent runtime files: ' + String(agentLog.stdout),
    );

    follower = spawnCli(['agent', 'logs', '-f', '-n', '0'], env);
    await waitFor(() => follower.pid, 5_000, 'follow reader pid');
    await SLEEP(600);
    assert.ok(isRunning(agentIdentity.pid), 'the daemon must be running before Ctrl-C');
    follower.kill('SIGINT');
    const cancelled = await waitForExit(follower, 10_000);
    assert.ok(
      cancelled.code === 0 || cancelled.code === 130 ||
        cancelled.signal === 'SIGINT' || cancelled.signal === null,
      'Ctrl-C must end the reader: ' + JSON.stringify(cancelled),
    );
    follower = null;
    assert.ok(
      isRunning(agentIdentity.pid),
      'Ctrl-C of logs must not terminate the Agent daemon',
    );
    assert.ok(
      fs.existsSync(path.join(runtime, 'agent.pid')),
      'Ctrl-C of logs must not remove the Agent identity',
    );
    evidence.push({
      type: 'runtime',
      value: sha + ': Agent logs -f reader exited on SIGINT while pid ' +
        agentIdentity.pid + ' stayed running and its identity remained',
    });

    // 3. Malformed config -> durable config diagnostic, no daemon.
    const badHome = mkdirPrivate(path.join(base, 'bad-home'));
    const badRuntime = mkdirPrivate(path.join(base, 'bad-runtime'));
    const badEnv = runtimeEnv({ home: badHome, runtimeDir: badRuntime });
    fs.writeFileSync(path.join(badHome, 'agent-config.toml'), '[agent\nthis is not toml\n');
    const malformed = mustFail(
      runCli(['agent', 'start', '--foreground'], badEnv, 30_000),
      'foreground start with malformed config',
    );
    assert.match(malformed, /failed to parse agent config/, malformed);
    const configStartup = startupLogs(badEnv);
    assert.match(configStartup, /agent config:/, configStartup);
    assert.match(configStartup, /failed to parse/, configStartup);
    assert.ok(
      !fs.existsSync(path.join(badRuntime, 'agent.pid')),
      'a malformed config must not leave an Agent identity',
    );
    evidence.push({
      type: 'runtime',
      value: sha + ': malformed config failed before startup and ' +
        startupFile(badHome) + ' held a retrievable config record',
    });

    // 3b. The same durable diagnostic exists for the Server CLI.
    fs.writeFileSync(path.join(badHome, 'server-config.toml'), '[server\nnot toml\n');
    const malformedServer = mustFail(
      runCli(['server', 'start', '--foreground'], badEnv, 30_000),
      'foreground Server start with malformed config',
    );
    assert.match(malformedServer, /failed to parse server config/, malformedServer);
    const serverConfigStartup = runCli(
      ['server', 'logs', '--source', 'startup', '-n', '50'],
      badEnv,
      30_000,
    );
    mustSucceed(serverConfigStartup, 'server logs --source startup');
    assert.match(
      String(serverConfigStartup.stdout),
      /server config:/,
      String(serverConfigStartup.stdout),
    );
    evidence.push({
      type: 'runtime',
      value: sha + ': malformed Server config failed before startup and ' +
        path.join(badHome, 'server', 'logs', 'startup', 'startup.log') +
        ' held a retrievable config record',
    });

    // 4. Early validation failure (before runtime logging exists).
    const validateHome = mkdirPrivate(path.join(base, 'validate-home'));
    const validateRuntime = mkdirPrivate(path.join(base, 'validate-runtime'));
    const validateEnv = runtimeEnv({ home: validateHome, runtimeDir: validateRuntime });
    fs.writeFileSync(
      path.join(validateHome, 'agent-config.toml'),
      configText({
        agentId: 'acceptance-4600-invalid',
        serverPort,
        agentPort: await freePort(),
        workDir: work,
        extra: ['terminal_cols = 0'],
      }),
    );
    mustFail(
      runCli(['agent', 'start', '--foreground'], validateEnv, 30_000),
      'foreground start with an invalid value',
    );
    const validateStartup = startupLogs(validateEnv);
    assert.match(validateStartup, /agent validate:/, validateStartup);
    assert.match(validateStartup, /NESSION_TERMINAL_COLS|terminal.*\[20, 400\]/, validateStartup);
    evidence.push({
      type: 'runtime',
      value: sha + ': an invalid terminal_cols value failed before log initialization and ' +
        'appeared as a validate record in --source startup',
    });

    // 5. Readiness failure: the Agent cannot bind its port.
    const readinessHome = mkdirPrivate(path.join(base, 'readiness-home'));
    const readinessRuntime = mkdirPrivate(path.join(base, 'readiness-runtime'));
    const readinessEnv = runtimeEnv({ home: readinessHome, runtimeDir: readinessRuntime });
    const occupiedPort = await freePort();
    blocker = await occupy(occupiedPort);
    fs.writeFileSync(
      path.join(readinessHome, 'agent-config.toml'),
      configText({
        agentId: 'acceptance-4600-readiness',
        serverPort,
        agentPort: occupiedPort,
        workDir: work,
      }),
    );
    const readinessError = mustFail(
      runCli(['agent', 'start'], readinessEnv, 60_000),
      'background start against an occupied port',
    );
    assert.match(readinessError, /exited before it was serving/, readinessError);
    const readinessStartup = startupLogs(readinessEnv);
    assert.match(readinessStartup, /agent readiness:/, readinessStartup);
    assert.match(readinessStartup, /Address already in use|failed to bind/, readinessStartup);
    assert.ok(
      !fs.existsSync(path.join(readinessRuntime, 'agent.pid')),
      'a readiness failure must not leave an Agent identity',
    );
    await closeServer(blocker);
    blocker = null;
    evidence.push({
      type: 'runtime',
      value: sha + ': an occupied Agent port produced an exited-before-serving readiness ' +
        'record in --source startup and no phantom identity',
    });

    // 6. A child stderr flood cannot deadlock the readiness handshake, and the
    //    durable record stays bounded and sanitized.
    const floodHome = mkdirPrivate(path.join(base, 'flood-home'));
    const floodRuntime = mkdirPrivate(path.join(base, 'flood-runtime'));
    const floodWork = mkdirPrivate(path.join(base, 'flood-work'));
    const floodEnv = runtimeEnv({
      home: floodHome,
      runtimeDir: floodRuntime,
      extra: { NESSION_TERMINAL_COLS: '9'.repeat(100_000) },
    });
    fs.writeFileSync(
      path.join(floodHome, 'agent-config.toml'),
      configText({
        agentId: 'acceptance-4600-flood',
        serverPort,
        agentPort: await freePort(),
        workDir: floodWork,
      }),
    );
    const floodStartedAt = Date.now();
    const floodError = mustFail(
      runCli(['agent', 'start'], floodEnv, 15_000),
      'background start with a 100 KB invalid value',
    );
    const floodElapsed = Date.now() - floodStartedAt;
    assert.ok(
      floodElapsed < 15_000,
      'the readiness handshake must not block on a full stderr pipe: ' + floodElapsed + 'ms',
    );
    assert.match(floodError, /NESSION_TERMINAL_COLS|startup diagnostics/, floodError);
    const floodStartup = startupLogs(floodEnv);
    assert.match(floodStartup, /agent validate:/, floodStartup.slice(0, 2000));
    const floodRecordSize = fs.statSync(startupFile(floodHome)).size;
    assert.ok(
      floodRecordSize <= 12 * 1024,
      'startup records must stay bounded (two capped records): ' + floodRecordSize,
    );
    evidence.push({
      type: 'runtime',
      value: sha + ': a 100 KB invalid value reached the child stderr path; startup ' +
        'completed in ' + floodElapsed + 'ms and the startup log was bounded at ' +
        floodRecordSize + ' bytes',
    });

    // 7. An unusable log path reports capture unavailability explicitly.
    const brokenHome = mkdirPrivate(path.join(base, 'broken-home'));
    const brokenRuntime = mkdirPrivate(path.join(base, 'broken-runtime'));
    fs.writeFileSync(path.join(brokenHome, 'agent'), 'not a directory\n');
    fs.writeFileSync(
      path.join(brokenHome, 'agent-config.toml'),
      configText({
        agentId: 'acceptance-4600-broken',
        serverPort,
        agentPort: await freePort(),
        workDir: work,
      }),
    );
    const brokenEnv = runtimeEnv({ home: brokenHome, runtimeDir: brokenRuntime });
    const brokenError = mustFail(
      runCli(['agent', 'start', '--foreground'], brokenEnv, 30_000),
      'foreground start with an unusable log path',
    );
    assert.match(brokenError, /startup diagnostics unavailable/, brokenError);
    assert.match(brokenError, /Not a directory|File exists/, brokenError);
    evidence.push({
      type: 'runtime',
      value: sha + ': an unusable <home>/agent path reported "startup diagnostics ' +
        'unavailable" while preserving the terminal/stderr diagnostic',
    });

    // 8. Ownership intact: explicit stop removes the daemon and its identity.
    mustSucceed(runCli(['agent', 'stop'], env, 60_000), 'agent stop');
    agentStarted = false;
    await waitFor(
      () => !isRunning(agentIdentity.pid),
      15_000,
      'Agent exit after stop',
    );
    assert.ok(
      !fs.existsSync(path.join(runtime, 'agent.pid')),
      'stop must remove the Agent identity',
    );
    mustSucceed(runCli(['server', 'stop'], env, 60_000), 'server stop');
    serverStarted = false;
    evidence.push({
      type: 'runtime',
      value: sha + ': explicit agent/server stop ended the recorded processes and removed ' +
        'their runtime identities',
    });

    return {
      summary:
        'Real exact-SHA CLI processes proved retrievable sanitized startup diagnostics ' +
        '(config/validate/readiness/unavailable), intact runtime logging and ownership, ' +
        'bounded flood-safe readiness and reader-only Ctrl-C for `logs -f`.',
      evidence,
    };
  } finally {
    if (follower) {
      follower.kill('SIGKILL');
      await waitForExit(follower, 5_000).catch(() => {});
    }
    await closeServer(blocker);
    if (agentStarted) {
      runCli(['agent', 'stop'], env, 60_000);
    }
    if (serverStarted) {
      runCli(['server', 'stop'], env, 60_000);
    }
  }
});
