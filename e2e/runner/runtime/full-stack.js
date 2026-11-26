#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');

const {
  acquirePortLease,
  assertOwnedPath,
  createRunRoot,
  removeRunRoot,
  sanitizedEnv,
  verifyRunRoot,
} = require('./test-runtime.js');

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(label + ' is required');
  return text;
}

function positivePort(value, label) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(label + ' must be a TCP port');
  }
  return port;
}

function positiveSeconds(value, label) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error(label + ' must be a positive integer number of seconds');
  }
  return seconds;
}

async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function tomlString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error('runtime config template is missing ' + label);
  return source.replace(pattern, replacement);
}

function renderServerConfig(template, { serverPort, home, webPort }) {
  let output = String(template);
  output = replaceRequired(
    output,
    /^listen_address\s*=\s*"[^"]*"$/m,
    `listen_address = "127.0.0.1:${positivePort(serverPort, 'serverPort')}"`,
    'server listen_address',
  );
  output = replaceRequired(
    output,
    /^db_path\s*=\s*"[^"]*"$/m,
    `db_path = "${tomlString(path.join(requiredText(home, 'home'), 'nession.db'))}"`,
    'server db_path',
  );
  // The checked-in template carries placeholder Web origins; the Server must
  // approve the preview origin this run actually serves (#4066). A custom
  // template with no allowance is left alone: its author owns that decision.
  const originLine = /^allowed_origins\s*=\s*\[[^\]]*\]$/m;
  if (originLine.test(output)) {
    const port = positivePort(webPort, 'webPort');
    output = output.replace(
      originLine,
      `allowed_origins = ["http://localhost:${port}", "http://127.0.0.1:${port}"]`,
    );
  }
  return output;
}

function renderAgentConfig(
  template,
  { serverPort, agentPort, stalledProbePort, home },
) {
  let output = String(template);
  output = replaceRequired(
    output,
    /^server_url\s*=\s*"[^"]*"$/m,
    `server_url = "ws://127.0.0.1:${positivePort(serverPort, 'serverPort')}/ws"`,
    'agent server_url',
  );
  output = replaceRequired(
    output,
    /^listen_address\s*=\s*"[^"]*"$/m,
    `listen_address = "127.0.0.1:${positivePort(agentPort, 'agentPort')}"`,
    'agent listen_address',
  );

  const urls = [...output.matchAll(/^url\s*=\s*"ws:\/\/127\.0\.0\.1:\d+\/ws"$/gm)];
  if (urls.length < 2) throw new Error('runtime agent template needs local and stalled advertise URLs');
  let urlIndex = 0;
  output = output.replace(/^url\s*=\s*"ws:\/\/127\.0\.0\.1:\d+\/ws"$/gm, () => {
    const port = urlIndex === 0
      ? positivePort(agentPort, 'agentPort')
      : positivePort(stalledProbePort, 'stalledProbePort');
    urlIndex += 1;
    return `url = "ws://127.0.0.1:${port}/ws"`;
  });

  output = replaceRequired(
    output,
    /^default_working_dir\s*=\s*"[^"]*"$/m,
    `default_working_dir = "${tomlString(requiredText(home, 'home'))}"`,
    'agent default_working_dir',
  );

  // The Acceptance Cases lane provisions a delegated cgroup v2 subtree and
  // exports its kernel-relative path. Let the real Agent measure the same
  // subtree its Sandbox Cases execute against; without this the Agent falls
  // back to its own (non-delegated) cgroup and truthfully reports no
  // configurable controller files. Local/web-only runs leave the variable
  // unset and keep the production default.
  const sandboxCgroupRoot = process.env.SANDBOX_CGROUP_ROOT;
  if (sandboxCgroupRoot && !/^\[sandbox\]\s*$/m.test(output)) {
    output += `\n[sandbox]\ncgroup_root = "${tomlString(sandboxCgroupRoot)}"\n`;
  }
  return output;
}

function assertOwnedRuntimePath(runRoot, value, label) {
  return assertOwnedPath(runRoot, requiredText(value, label), label);
}

function assertTargetSha(repoRoot, targetSha) {
  const expected = String(targetSha ?? '').trim();
  const actual = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (expected && actual !== expected) {
    throw new Error(`runtime target SHA mismatch: checkout ${actual}, requested ${expected}`);
  }
  return actual;
}

async function waitForTcp(port, timeoutMs, child, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(label + ' exited before readiness with code ' + child.exitCode);
    }
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await sleep(200);
  }
  throw new Error(label + ' did not become ready on port ' + port + ' within ' + timeoutMs + 'ms');
}

async function waitForHttp(url, timeoutMs, child, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(label + ' exited before readiness with code ' + child.exitCode);
    }
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // Retry until the explicit readiness deadline.
    }
    await sleep(200);
  }
  throw new Error(label + ' did not become ready at ' + url + ' within ' + timeoutMs + 'ms');
}

function spawnManaged(command, args, { cwd, env, label }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    console.error('[e2e runner] ' + label + ' spawn error:', error);
  });
  return { child, label };
}

async function stopManaged(entry) {
  if (!entry?.child || entry.child.exitCode != null) return;
  const child = entry.child;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    return;
  }

  const exited = once(child, 'exit').then(() => true);
  const timedOut = sleep(PROCESS_STOP_TIMEOUT_MS).then(() => false);
  if (await Promise.race([exited, timedOut])) return;

  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function binaryCommand(repoRoot, packageName, binaryName, configPath) {
  const binary = path.join(repoRoot, 'target', 'debug', binaryName);
  if (existsSync(binary)) return { command: binary, args: [configPath] };
  return {
    command: 'cargo',
    args: ['run', '-p', packageName, '--', configPath],
  };
}

/// Agent CLIs an e2e/Case runtime can install at an exact version.
///
/// The runtime is product-neutral: a Case declares the CLI version it wants to
/// exercise, and only the named provider is installed into the isolated
/// runtime home. Adding another provider is one entry here plus its adapter
/// tests; it is never a version allowlist in product code.
const AGENT_CLI_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
};

function agentCliVersionsFrom(value) {
  const raw = value ?? process.env.NESSION_AGENT_CLI_VERSIONS;
  if (raw == null || raw === '') return {};
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error('agent CLI versions must be a JSON object: ' + error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('agent CLI versions must be an object of provider -> exact version');
  }
  const versions = {};
  for (const [provider, version] of Object.entries(parsed)) {
    if (!Object.hasOwn(AGENT_CLI_PACKAGES, provider)) {
      throw new Error('unsupported e2e agent CLI provider: ' + provider);
    }
    const exact = String(version ?? '').trim();
    // Exact semver only: a tag such as `latest` would make the run's evidence
    // non-reproducible, and an option-looking value must never reach npm.
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(exact)) {
      throw new Error('e2e agent CLI ' + provider + ' needs an exact version, got: ' + exact);
    }
    versions[provider] = exact;
  }
  return versions;
}

function installAgentClis(home, versions, childEnv) {
  const installed = {};
  for (const [provider, version] of Object.entries(versions)) {
    const prefix = path.join(home, 'agent-clis', provider + '-' + version);
    mkdirSync(prefix, { recursive: true });
    execFileSync(
      'npm',
      [
        'install',
        '--prefix', prefix,
        '--no-save',
        '--no-audit',
        '--no-fund',
        AGENT_CLI_PACKAGES[provider] + '@' + version,
      ],
      { stdio: 'inherit', env: childEnv },
    );
    const bin = path.join(prefix, 'node_modules', '.bin', provider);
    if (!existsSync(bin)) {
      throw new Error('e2e agent CLI ' + provider + '@' + version + ' installed no `' + provider + '` binary');
    }
    const resolved = String(execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      env: childEnv,
    })).trim();
    installed[provider] = {
      requested_version: version,
      resolved_version: resolved,
      bin_dir: path.dirname(bin),
    };
  }
  return installed;
}

function verifyAndKillTmux(runRoot, tmuxSocket) {
  assertOwnedPath(runRoot, tmuxSocket, 'tmux socket');
  if (!existsSync(tmuxSocket)) return;
  let reported = '';
  try {
    reported = execFileSync(
      'tmux',
      ['-S', tmuxSocket, 'display-message', '-p', '#{socket_path}'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    // No live tmux server on this owned socket: a stale socket file with
    // nothing to kill. The caller may remove the owned socket directory.
    reported = '';
  }
  if (reported === '') return;
  if (reported !== tmuxSocket) {
    throw new Error(
      'refusing socket cleanup: server reported ' + reported +
      ', expected ' + tmuxSocket + ' (#4597)',
    );
  }
  execFileSync('tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
}

async function startFullStackRuntime(options) {
  const repoRoot = path.resolve(requiredText(options?.repoRoot, 'repoRoot'));
  // One verified Test Runtime root owns every mutable resource this run
  // touches. A caller without a manifest-backed root fails closed before any
  // process starts or any path is removed (#4597).
  const ownership = verifyRunRoot(requiredText(options?.runRoot, 'runRoot'));
  const runRoot = ownership.root;
  const home = assertOwnedRuntimePath(
    runRoot,
    options?.home ?? path.join(runRoot, 'home'),
    'home',
  );
  const tmuxSocket = assertOwnedRuntimePath(
    runRoot,
    options?.tmuxSocket ?? path.join(runRoot, 'tmux.sock'),
    'tmux socket',
  );
  const tmuxDir = assertOwnedRuntimePath(runRoot, path.dirname(tmuxSocket), 'tmux socket directory');
  const serverPort = positivePort(
    options?.serverPort ?? await allocateLoopbackPort(),
    'serverPort',
  );
  const agentPort = positivePort(
    options?.agentPort ?? await allocateLoopbackPort(),
    'agentPort',
  );
  const webPort = positivePort(
    options?.webPort ?? await allocateLoopbackPort(),
    'webPort',
  );
  const stalledProbePort = positivePort(
    options?.stalledProbePort ?? await allocateLoopbackPort(),
    'stalledProbePort',
  );
  const readyTimeoutMs = Number(options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  const cleanupHome = options?.cleanupHome !== false;
  const cleanupRoot = options?.cleanupRoot === true;
  const targetSha = assertTargetSha(repoRoot, options?.targetSha);
  // #1866 SC-01: fixture-only browser gates (the design-system browser profile)
  // need the built web app and nothing else. A web-only runtime still proves
  // the preview is ready, but does not start Server, Agent or tmux, so a
  // `not-required` E2E plan can skip the Rust build entirely.
  const webOnly = options?.webOnly === true;
  const profile = options?.profile ?? (webOnly ? 'web-only' : 'full-stack-local');
  const serverTemplate = path.resolve(
    options?.serverConfigTemplate ??
    path.join(repoRoot, 'e2e', 'fixtures', 'server', 'config.toml'),
  );
  const agentTemplate = path.resolve(
    options?.agentConfigTemplate ??
    path.join(repoRoot, 'e2e', 'fixtures', 'agent-config.e2e.toml'),
  );

  // The root is fresh and ownership-verified; nothing from an earlier run is
  // inherited, so there is no unverified path to wipe (#4597).
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
  if (tmuxDir !== runRoot) {
    writeFileSync(path.join(tmuxDir, 'owner.pid'), String(process.pid));
  }

  const baseEnv = sanitizedEnv(runRoot, tmuxSocket);

  // Exact agent CLI versions under test. Installed into the isolated runtime
  // home and prepended to the Agent's PATH; the product code is never told a
  // version, so every version is exercised through the same probe.
  const agentClis = webOnly
    ? {}
    : installAgentClis(home, agentCliVersionsFrom(options?.agentCliVersions), baseEnv);
  const agentCliBinDirs = Object.values(agentClis).map((cli) => cli.bin_dir);
  const agentEnvPath = [...agentCliBinDirs, baseEnv.PATH || ''].join(path.delimiter);

  const configDir = path.join(home, 'runtime-config');
  mkdirSync(configDir, { recursive: true });
  const serverConfig = path.join(configDir, 'server.toml');
  const agentConfig = path.join(configDir, 'agent.toml');

  writeFileSync(
    serverConfig,
    renderServerConfig(readFileSync(serverTemplate, 'utf8'), {
      serverPort,
      home,
      webPort,
    }),
  );
  writeFileSync(
    agentConfig,
    renderAgentConfig(readFileSync(agentTemplate, 'utf8'), {
      serverPort,
      agentPort,
      stalledProbePort,
      home,
    }),
  );

  const processes = [];

  const stop = async () => {
    const failures = [];
    for (const entry of [...processes].reverse()) {
      try { await stopManaged(entry); } catch (error) { failures.push(String(error)); }
    }
    try { verifyAndKillTmux(runRoot, tmuxSocket); } catch (error) { failures.push(String(error)); }
    if (tmuxDir !== runRoot) {
      try {
        assertOwnedPath(runRoot, tmuxDir, 'socket directory');
        rmSync(tmuxDir, { recursive: true, force: true });
      } catch (error) { failures.push(String(error)); }
    }
    if (cleanupHome) {
      try {
        assertOwnedPath(runRoot, home, 'home');
        rmSync(home, { recursive: true, force: true });
      } catch (error) { failures.push(String(error)); }
    }
    if (cleanupRoot && failures.length === 0) {
      try { removeRunRoot(runRoot); } catch (error) { failures.push(String(error)); }
    }
    if (failures.length > 0) {
      // Keep the root and its manifest for the reaper; deleting unverified or
      // partially stopped resources is how a test run becomes another leak.
      throw new Error('runtime teardown failed (#4597): ' + failures.join('; '));
    }
  };

  // The Agent is the one process a test may restart: its tmux sessions live in
  // the separate tmux server, so a restart is the real failure shape — a new
  // process with a new stream epoch over the sessions that survived (#1926
  // SC-05). Kept out of the `webOnly` profile, which has no Agent at all.
  let agentEntry = null;
  const startAgentProcess = async () => {
    const agent = binaryCommand(repoRoot, 'nession-agent', 'nession-agent', agentConfig);
    const entry = spawnManaged(agent.command, agent.args, {
      cwd: repoRoot,
      env: sanitizedEnv(runRoot, tmuxSocket, {
        PATH: agentEnvPath,
        LANG: 'C.UTF-8',
        RUST_LOG: 'info',
        RUST_BACKTRACE: '1',
      }),
      label: 'nession-agent',
    });
    processes.push(entry);
    await waitForTcp(agentPort, readyTimeoutMs, entry.child, entry.label);
    return entry;
  };
  const restartAgent = async () => {
    if (webOnly) throw new Error('the web-only runtime has no agent to restart');
    if (!agentEntry) throw new Error('the agent has not been started');
    const previous = agentEntry;
    agentEntry = null;
    await stopManaged(previous);
    agentEntry = await startAgentProcess();
    return { restarted: true, pid: agentEntry.child.pid ?? null };
  };

  try {
    if (!webOnly) {
      const server = binaryCommand(repoRoot, 'nession-server', 'nession-server', serverConfig);
      const serverProcess = spawnManaged(server.command, server.args, {
        cwd: repoRoot,
        env: sanitizedEnv(runRoot, tmuxSocket, {
          RUST_LOG: 'info',
          RUST_BACKTRACE: '1',
        }),
        label: 'nession-server',
      });
      processes.push(serverProcess);
      await waitForTcp(serverPort, readyTimeoutMs, serverProcess.child, serverProcess.label);

      // Preserve the existing E2E stabilization window after server readiness.
      await sleep(Number(options?.agentStartDelayMs ?? 5_000));

      agentEntry = await startAgentProcess();
    }

    const webProcess = spawnManaged(
      'npm',
      ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      {
        cwd: path.join(repoRoot, 'web'),
        env: sanitizedEnv(runRoot, tmuxSocket, {
          NESSION_DEV_WS_PROXY: 'http://127.0.0.1:' + serverPort,
        }),
        label: 'web-preview',
      },
    );
    processes.push(webProcess);
    const readinessURL = 'http://127.0.0.1:' + webPort;
    const baseURL = 'http://localhost:' + webPort;
    await waitForHttp(readinessURL, 30_000, webProcess.child, webProcess.label);

    const metadata = {
      schema_version: 1,
      target_sha: targetSha,
      profile,
      run_root: runRoot,
      run_id: ownership.manifest.run_id,
      home,
      tmux_socket: tmuxSocket,
      // A web-only runtime has no Server/Agent; reporting invented ports would
      // claim a stack that was never started.
      ...(webOnly ? {} : { server_port: serverPort, agent_port: agentPort }),
      web_port: webPort,
      base_url: baseURL,
      // The CLI version under test, as requested and as installed. Product
      // evidence can cite the exact version without re-reading the host PATH.
      ...(Object.keys(agentClis).length === 0 ? {} : {
        agent_cli: Object.fromEntries(Object.entries(agentClis).map(([provider, cli]) => [
          provider,
          { requested_version: cli.requested_version, resolved_version: cli.resolved_version },
        ])),
      }),
    };
    writeFileSync(path.join(home, 'runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
    // #1866: a bounded, non-sensitive provision counter. The Full E2E Gate used
    // to start this stack twice per invocation and nothing in CI recorded it, so
    // "at most once" was unmeasurable. One appended line per real provision lets
    // the owning Gate report a measured count instead of a claim. Absolute paths
    // only; failures here must never break provisioning.
    const provisionLog = process.env.E2E_RUNTIME_PROVISION_LOG;
    if (typeof provisionLog === 'string' && path.isAbsolute(provisionLog)) {
      try {
        appendFileSync(provisionLog,
          JSON.stringify({ profile: metadata.profile, web_only: webOnly,
            at: new Date().toISOString() }) + '\n');
      } catch { /* measurement is best-effort; never fail the runtime for it */ }
    }
    console.log('[e2e runner] ready ' + JSON.stringify(metadata));

    return { ...metadata, stop, restartAgent };
  } catch (error) {
    try {
      await stop();
    } catch (stopError) {
      throw new Error(
        'runtime failed (' + String(error) + ') and teardown failed (' +
        String(stopError) + ') (#4597)',
      );
    }
    throw error;
  }
}

function selfTest() {
  const serverTemplate = [
    'listen_address = "127.0.0.1:19090"',
    'db_path = "/tmp/nession-e2e/nession.db"',
    'allowed_origins = ["http://localhost:4173", "http://127.0.0.1:4173"]',
  ].join('\n');
  const agentTemplate = [
    'server_url = "ws://127.0.0.1:19090/ws"',
    'listen_address = "127.0.0.1:19091"',
    'url = "ws://127.0.0.1:19091/ws"',
    'url = "ws://127.0.0.1:19092/ws"',
    'default_working_dir = "/tmp/nession-e2e"',
  ].join('\n');

  const home = path.join(os.tmpdir(), 'nession-runtime-selftest');
  const server = renderServerConfig(serverTemplate, {
    serverPort: 21090,
    home,
    webPort: 24173,
  });
  assert.match(server, /127\.0\.0\.1:21090/);
  assert.match(server, /nession-runtime-selftest\/nession\.db/);
  assert.match(
    server,
    /^allowed_origins = \["http:\/\/localhost:24173", "http:\/\/127\.0\.0\.1:24173"\]$/m,
    'a browser origin allowance must name the preview origin actually served',
  );

  const agent = renderAgentConfig(agentTemplate, {
    serverPort: 21090,
    agentPort: 21091,
    stalledProbePort: 21092,
    home,
  });
  assert.match(agent, /server_url = "ws:\/\/127\.0\.0\.1:21090\/ws"/);
  assert.match(agent, /listen_address = "127\.0\.0\.1:21091"/);
  assert.match(agent, /url = "ws:\/\/127\.0\.0\.1:21092\/ws"/);
  assert.match(agent, /default_working_dir = ".*nession-runtime-selftest"/);

  assert.throws(
    () => renderServerConfig('db_path = "/tmp/x"', { serverPort: 21090, home }),
    /listen_address/,
  );
  assert.throws(() => positivePort(0, 'port'), /TCP port/);
  assert.deepEqual(agentCliVersionsFrom({ claude: '2.1.326' }), { claude: '2.1.326' });
  assert.throws(() => agentCliVersionsFrom({ claude: 'latest' }), /exact version/);
  assert.throws(() => agentCliVersionsFrom({ claude: '--include=dev' }), /exact version/);
  assert.throws(() => agentCliVersionsFrom({ codex: '1.0.0' }), /unsupported e2e agent CLI/);
  assert.throws(() => agentCliVersionsFrom('not json'), /JSON object/);

  const previousSandboxRoot = process.env.SANDBOX_CGROUP_ROOT;
  try {
    delete process.env.SANDBOX_CGROUP_ROOT;
    assert.doesNotMatch(
      renderAgentConfig(agentTemplate, {
        serverPort: 21090,
        agentPort: 21091,
        stalledProbePort: 21092,
        home,
      }),
      /^\[sandbox\]$/m,
      'a local runtime keeps the production cgroup default',
    );
    process.env.SANDBOX_CGROUP_ROOT = '/nession-accept';
    const sandboxed = renderAgentConfig(agentTemplate, {
      serverPort: 21090,
      agentPort: 21091,
      stalledProbePort: 21092,
      home,
    });
    assert.match(sandboxed, /^\[sandbox\]\ncgroup_root = "\/nession-accept"$/m);
    assert.equal(sandboxed.match(/^\[sandbox\]$/gm).length, 1);
  } finally {
    if (previousSandboxRoot === undefined) delete process.env.SANDBOX_CGROUP_ROOT;
    else process.env.SANDBOX_CGROUP_ROOT = previousSandboxRoot;
  }
  // Test Runtime ownership contract: a fresh root verifies, a child
  // environment is run-owned/sanitized, an outside path is refused, and the
  // verified root (and its lease) can be removed (#4597).
  const run = createRunRoot('nession-runtime-selftest');
  try {
    const verified = verifyRunRoot(run.root);
    assert.equal(verified.manifest.lifecycle, 'active');
    assert.notEqual(sanitizedEnv(run.root, run.tmuxSocket).HOME, process.env.HOME);
    assert.ok(sanitizedEnv(run.root, run.tmuxSocket).HOME.startsWith(run.root));
    assert.ok(!('ANTHROPIC_API_KEY' in sanitizedEnv(run.root, run.tmuxSocket)));
    assert.throws(() => assertOwnedPath(run.root, '/tmp/not-this-run', 'probe'), /outside/);
    const lease = acquirePortLease(run.root);
    assert.equal(lease.ports.length, 4);
    lease.release();
  } finally {
    removeRunRoot(run.root);
  }
  console.log('e2e runner runtime self-test: 13 cases passed');
}

module.exports = {
  allocateLoopbackPort,
  assertTargetSha,
  agentCliVersionsFrom,
  binaryCommand,
  installAgentClis,
  renderAgentConfig,
  renderServerConfig,
  startFullStackRuntime,
};

if (require.main === module) {
  const command = process.argv[2];
  if (command === 'self-test') selfTest();
  else {
    console.error('usage: node e2e/runner/runtime/full-stack.js self-test');
    process.exitCode = 2;
  }
}
