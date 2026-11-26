'use strict';
// The JS side of the single Test Runtime owner (#4597).
//
// The Rust boundary lives in `crates/nession-common/src/test_runtime.rs`; the
// shell wrapper lives in `scripts/test-runtime.sh`. This module gives the E2E
// and Acceptance harnesses the same contract: one run root, an ownership
// manifest, a private tmux socket and an explicit run-owned environment for
// every child process.
//
// A run root is short (`/tmp/nession-*.XXXXXX`) on purpose: tests derive unix
// sockets inside it, and macOS per-user temp paths plus a longer root easily
// exceed `sockaddr_un.sun_path` (104 bytes). Ownership is not the name prefix:
// the root must be a real directory owned by this uid with no group/other
// bits, holding a non-symlink manifest whose root/uid/lifecycle agree and whose
// owner.pid is alive. Destructive operations verify all of that first; a
// failed or uncertain claim keeps the directory for
// `scripts/sweep-test-sessions.sh` instead of guessing.

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const MANIFEST_FILE = 'manifest.json';
const OWNER_FILE = 'owner.pid';
const SCHEMA_VERSION = 1;

function processUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const resolved = path.resolve(candidate);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/** The longest existing ancestor, canonicalized, must stay inside `root`. */
function assertOwnedPath(root, candidate, label) {
  const resolved = path.resolve(String(candidate));
  if (!isWithin(root, resolved)) {
    throw new Error(
      `${label} ${resolved} is outside this run's Test Runtime root ${root} (#4597)`,
    );
  }
  let ancestor = resolved;
  for (;;) {
    let metadata = null;
    try {
      metadata = fs.lstatSync(ancestor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (metadata !== null) {
      if (metadata.isSymbolicLink()) {
        let canonical;
        try {
          canonical = fs.realpathSync(ancestor);
        } catch (error) {
          throw new Error(
            `${label} ${resolved} is a symlink that does not resolve (${error.code}); ` +
            `it cannot be proven inside this run's Test Runtime root ${root} (#4597)`,
          );
        }
        if (!isWithin(fs.realpathSync(root), canonical)) {
          throw new Error(
            `${label} ${resolved} resolves outside this run's Test Runtime root ${root} (#4597)`,
          );
        }
        return resolved;
      }
      const canonical = fs.realpathSync(ancestor);
      if (!isWithin(fs.realpathSync(root), canonical)) {
        throw new Error(
          `${label} ${resolved} is outside this run's Test Runtime root ${root} (#4597)`,
        );
      }
      return resolved;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`${label} ${resolved} has no existing ancestor inside ${root}`);
    }
    ancestor = parent;
  }
}

function writeManifest(root, tmuxSocket) {
  const manifest = {
    schema_version: SCHEMA_VERSION,
    run_id: crypto.randomBytes(8).toString('hex'),
    owner_pid: process.pid,
    owner_started: new Date().toISOString(),
    uid: processUid(),
    root,
    tmux_socket: tmuxSocket,
    lifecycle: 'active',
  };
  fs.writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(root, OWNER_FILE), String(process.pid) + '\n');
  return manifest;
}

/**
 * Create a fresh run root under `parent` (default `/tmp`, for short paths).
 * Returns the verified context.
 */
function createRunRoot(label = 'nession-test-runtime', parent = '/tmp') {
  fs.mkdirSync(parent, { recursive: true });
  const created = fs.mkdtempSync(path.join(parent, label + '.'));
  // Canonicalize now: macOS /tmp is a symlink to /private/tmp, and the
  // manifest and every derived socket must agree on one spelling.
  const root = fs.realpathSync(created);
  fs.chmodSync(root, 0o700);
  const tmuxSocket = path.join(root, 'tmux.sock');
  for (const dir of ['home', 'runtime', 'tmp', 'config', 'cache', 'data', 'state']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(path.join(root, 'gitconfig'), '');
  fs.writeFileSync(path.join(root, 'gitconfig-system'), '');
  const manifest = writeManifest(root, tmuxSocket);
  return {
    root,
    manifestFile: path.join(root, MANIFEST_FILE),
    manifest,
    tmuxSocket,
    home: path.join(root, 'home'),
  };
}

/** Verify `root` and return its manifest; throws when any claim fails. */
function verifyRunRoot(root) {
  const base = path.resolve(String(root));
  const metadata = fs.lstatSync(base);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Test Runtime root ${base} is a symlink; the run root must be a real directory (#4597)`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Test Runtime root ${base} is not a directory (#4597)`);
  }
  if (metadata.uid !== processUid()) {
    throw new Error(
      `Test Runtime root ${base} is owned by uid ${metadata.uid}, not the current user (uid ${processUid()}) (#4597)`,
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Test Runtime root ${base} is accessible by group or other users; it must be 0700 (#4597)`);
  }
  const canonical = fs.realpathSync(base);
  const manifestPath = path.join(canonical, MANIFEST_FILE);
  const manifestMetadata = fs.lstatSync(manifestPath);
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
    throw new Error(`Test Runtime manifest ${manifestPath} must be a real file (#4597)`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Number(manifest.schema_version) !== SCHEMA_VERSION) {
    throw new Error(`Test Runtime manifest schema_version ${manifest.schema_version} is unsupported (#4597)`);
  }
  if (!String(manifest.run_id || '').trim()) {
    throw new Error(`Test Runtime manifest ${manifestPath} has an empty run_id (#4597)`);
  }
  if (manifest.lifecycle !== 'active') {
    throw new Error(`Test Runtime manifest ${manifestPath} is '${manifest.lifecycle}', not 'active' (#4597)`);
  }
  if (Number(manifest.uid) !== processUid()) {
    throw new Error(`Test Runtime manifest ${manifestPath} names uid ${manifest.uid}, not this user (#4597)`);
  }
  if (path.resolve(String(manifest.root)) !== canonical) {
    throw new Error(`Test Runtime manifest ${manifestPath} names root '${manifest.root}', not ${canonical} (#4597)`);
  }
  if (!isWithin(canonical, String(manifest.tmux_socket || ''))) {
    throw new Error(`Test Runtime manifest ${manifestPath} names a tmux socket outside the run root (#4597)`);
  }
  const ownerPid = Number(fs.readFileSync(path.join(canonical, OWNER_FILE), 'utf8').trim());
  if (!isAlive(ownerPid)) {
    throw new Error(
      `Test Runtime root ${canonical} is owned by pid ${ownerPid}, which is not running; it is a stale run (#4597)`,
    );
  }
  return { root: canonical, manifest, manifestFile: manifestPath };
}

/** Remove a verified run root; refuses anything that is not ours. */
function removeRunRoot(root) {
  const verified = verifyRunRoot(root);
  if (!path.basename(verified.root).startsWith('nession-')) {
    throw new Error(`refusing to remove ${verified.root}: not a nession run root (#4597)`);
  }
  fs.rmSync(verified.root, { recursive: true, force: false });
}

const PASS_THROUGH = [
  'PATH', 'LANG', 'LANGUAGE', 'TZ', 'SHELL', 'TERM', 'CI',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE',
  // Read-only build/toolchain caching is explicitly shared infrastructure, not
  // mutable test state (see the #4597 design decision). These let a Case run
  // `cargo test` without downloading a second registry or toolchain; they are
  // not forwarded to the Server/Agent/Web runtime children.
  'CARGO_HOME', 'RUSTUP_HOME', 'CARGO_TARGET_DIR', 'RUSTUP_TOOLCHAIN',
  'RUST_BACKTRACE', 'SCCACHE_DIR', 'SCCACHE_CACHE_SIZE', 'SCCACHE_GHA_ENABLED',
  'PLAYWRIGHT_BROWSERS_PATH',
];

/**
 * The default child environment for a test runtime.
 *
 * Only non-secret toolchain/locale inputs survive. HOME, every XDG root, the
 * tool configs, git configs, TMPDIR, the Nession roots and the tmux socket are
 * run-owned. Provider credentials, GitHub tokens, proxies, ssh-agent and
 * NODE_OPTIONS are not forwarded; a Case that needs a credential declares its
 * own explicit lane.
 */
function sanitizedEnv(runRoot, tmuxSocket, overrides = {}) {
  const verified = verifyRunRoot(runRoot);
  const root = verified.root;
  const home = path.join(root, 'home');
  const env = {};
  for (const key of PASS_THROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = home;
  env.NESSION_HOME = path.join(home, '.nession');
  env.NESSION_RUNTIME_DIR = path.join(root, 'runtime');
  env.TMPDIR = path.join(root, 'tmp');
  env.XDG_CONFIG_HOME = path.join(root, 'config');
  env.XDG_CACHE_HOME = path.join(root, 'cache');
  env.XDG_DATA_HOME = path.join(root, 'data');
  env.XDG_STATE_HOME = path.join(root, 'state');
  env.CLAUDE_CONFIG_DIR = path.join(root, 'config', 'claude');
  env.CODEX_HOME = path.join(root, 'config', 'codex');
  env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
  env.GIT_CONFIG_SYSTEM = path.join(root, 'gitconfig-system');
  env.NESSION_TMUX_SOCKET = tmuxSocket;
  return { ...env, ...overrides };
}

// ── Endpoint leases ─────────────────────────────────────────────────────────
// Two independent E2E runs must coexist. A lease file is created with O_EXCL
// per port block; a live owner keeps the block, a dead owner's lease is
// reclaimed. Ports are then probed (bind/connect) before the block is used.
// This is a same-machine coordination contract for test runs, not a security
// boundary.

const LEASE_DIR = '/tmp/nession-e2e-leases';

function portBlock(index) {
  if (index === 0) return [19090, 19091, 19092, 4173];
  const base = 19100 + index * 10;
  return [base, base + 1, base + 2, base + 3];
}

function portsAreFree(ports) {
  // A synchronous child keeps module evaluation synchronous: Playwright reads
  // E2E_WEB_URL at config load, before any async setup hook can run.
  const script = [
    "const net=require('net');",
    `const ports=${JSON.stringify(ports)};`,
    'let i=0;',
    'const next=()=>{',
    '  if(i===ports.length){process.exit(0);}',
    '  const s=net.createConnection({host:"127.0.0.1",port:ports[i++]});',
    '  s.setTimeout(300);',
    '  s.once("connect",()=>{s.destroy();process.exit(1);});',
    '  s.once("error",()=>next());',
    '  s.once("timeout",()=>{s.destroy();process.exit(1);});',
    '};',
    'next();',
  ].join('');
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function readLeaseOwner(lockFile) {
  try {
    const body = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return { pid: Number(body.pid), run_id: String(body.run_id || '') };
  } catch {
    return { pid: 0, run_id: '' };
  }
}

function acquirePortLease(runRoot) {
  fs.mkdirSync(LEASE_DIR, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 64; index += 1) {
    const ports = portBlock(index);
    const lockFile = path.join(LEASE_DIR, 'block-' + index + '.json');
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readLeaseOwner(lockFile);
      if (owner.pid > 0 && isAlive(owner.pid)) continue;
      // A dead owner cannot be using the ports; reclaim its lease.
      try { fs.unlinkSync(lockFile); } catch { /* raced with another reclaimer */ }
      try {
        fd = fs.openSync(lockFile, 'wx', 0o600);
      } catch (retryError) {
        if (retryError.code === 'EEXIST') continue;
        throw retryError;
      }
    }
    const lease = {
      run_id: crypto.randomBytes(8).toString('hex'),
      pid: process.pid,
      started_at: new Date().toISOString(),
      root: runRoot,
      ports,
    };
    fs.writeSync(fd, JSON.stringify(lease) + '\n');
    fs.closeSync(fd);
    if (!portsAreFree(ports)) {
      fs.unlinkSync(lockFile);
      continue;
    }
    const release = () => {
      try {
        const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (current.run_id === lease.run_id) fs.unlinkSync(lockFile);
      } catch { /* already released or reclaimed */ }
    };
    process.once('exit', release);
    return { ...lease, lockFile, release };
  }
  throw new Error('no free E2E port block is available (#4597)');
}

module.exports = {
  MANIFEST_FILE,
  OWNER_FILE,
  assertOwnedPath,
  acquirePortLease,
  createRunRoot,
  isWithin,
  removeRunRoot,
  sanitizedEnv,
  verifyRunRoot,
};
