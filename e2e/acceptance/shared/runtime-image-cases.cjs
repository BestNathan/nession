'use strict';
// Shared machinery for the #3178 runtime-image Cases.
//
// The guard proves the from-source and prebuilt variants of each role share
// one byte-identical `runtime-tools` packaging definition. The Case then builds
// that stage from the target checkout and executes the shipped tools inside
// it, so a missing executable is a measured failure rather than a source
// reading. Only the `runtime-tools` stage is built: the Rust/web stages are not
// dependencies of it, so the proof stays inside the verifier budget.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checked } = require('./control-mode-cases.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const FIXED_UUID = '11111111-1111-4111-8111-111111111111';

/** Run the canonical Dockerfile packaging guard for the target checkout. */
function guard() {
  return checked('node', ['scripts/runtime-image-tools.mjs'], 30000).trim();
}

/** Build the actual `runtime-tools` stage named by one Dockerfile. */
function buildRuntimeTools(file, tag, timeout = 100000) {
  checked(
    'docker',
    ['build', '--target', 'runtime-tools', '-f', file, '-t', tag, '.'],
    timeout,
  );
  return checked('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], 15000).trim();
}

/** Build the pinned EROFS tool builder stage (a cache hit after runtime-tools). */
function buildErofsUtilsBuilder(file, tag, timeout = 100000) {
  checked(
    'docker',
    ['build', '--target', 'erofs-utils-builder', '-f', file, '-t', tag, '.'],
    timeout,
  );
}

/** Build a deterministic uncompressed EROFS fixture with the pinned mkfs.erofs. */
function createFixture(builderTag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3178-fixture-'));
  const script = `set -euo pipefail
# The container runs as root while the host created this directory; keep the
# created tree writable by the runner user so post-proof cleanup can unlink it.
umask 000
mkdir -p /fixture/source
printf 'packaged-fixture\\n' > /fixture/source/hello.txt
mkfs.erofs -T 0 -U ${FIXED_UUID} -b 4096 /fixture/fixture.erofs /fixture/source
sha256sum /fixture/fixture.erofs | cut -d' ' -f1 > /fixture/digest
od -An -tx1 -j1024 -N4 /fixture/fixture.erofs | tr -d ' \\n' > /fixture/magic
`;
  try {
    checked('docker', ['run', '--rm', '-v', `${dir}:/fixture`, builderTag, 'bash', '-lc', script], 30000);
    return {
      dir,
      digest: fs.readFileSync(path.join(dir, 'digest'), 'utf8').trim(),
      magic: fs.readFileSync(path.join(dir, 'magic'), 'utf8').trim(),
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function removeFixture(fixture) {
  if (!fixture) return;
  try {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  } catch (error) {
    // A root-owned fixture entry can still be unlinkable by the runner user on
    // some container runtimes. Cleanup is not the criterion: never turn an
    // already-proven mount/unmount result into a Case failure.
    console.warn('could not remove EROFS fixture ' + fixture.dir + ': ' + error.message);
  }
}

/** Run a bash script inside an already-built stage image. */
function runInImage(tag, script, { fuse = false, volumes = [] } = {}, timeout = 30000) {
  const args = ['run', '--rm'];
  // `erofsfuse` needs the FUSE device and mount capability inside this throwaway
  // verification container; the production Pod is not made privileged (#3178).
  // AppArmor is relaxed only for that container because the Ubuntu runner's
  // docker-default profile otherwise denies the helper's mount.
  if (fuse) {
    args.push('--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined');
  }
  for (const volume of volumes) args.push('-v', volume);
  args.push(tag, 'bash', '-lc', script);
  return checked('docker', args, timeout);
}

/** One-line result marker emitted by every probe. */
function resultLine(output) {
  const line = String(output)
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('RUNTIME_RESULT '));
  if (!line) throw new Error('the runtime probe emitted no RUNTIME_RESULT line: ' + output.slice(-2000));
  return line.slice('RUNTIME_RESULT '.length);
}

const SERVER_PROBE = `set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/source"
printf 'packaged-blob\\n' > "$work/source/file.txt"
git init -q "$work/snapshot"
cp "$work/source/file.txt" "$work/snapshot/file.txt"
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
git -C "$work/snapshot" add file.txt
git -C "$work/snapshot" commit -q -m fixture
mkfs.erofs -T 0 -U ${FIXED_UUID} -b 4096 "$work/first.erofs" "$work/snapshot"
mkfs.erofs -T 0 -U ${FIXED_UUID} -b 4096 "$work/second.erofs" "$work/snapshot"
first=$(sha256sum "$work/first.erofs" | cut -d' ' -f1)
second=$(sha256sum "$work/second.erofs" | cut -d' ' -f1)
test "$first" = "$second"
magic=$(od -An -tx1 -j1024 -N4 "$work/first.erofs" | tr -d ' \\n')
test "$magic" = "e2e1f5e0"
git_version=$(git --version)
tool_version=$(mkfs.erofs -V 2>&1 | head -1)
if PATH=/usr/bin:/bin command -v mkfs.erofs >/dev/null 2>&1; then
  echo "NEGATIVE_HELPER_STILL_VISIBLE"
  exit 1
fi
if PATH=/usr/bin:/bin mkfs.erofs -T 0 -U ${FIXED_UUID} -b 4096 "$work/negative.erofs" "$work/snapshot" 2>"$work/negative.log"; then
  echo "NEGATIVE_HELPER_RAN"
  exit 1
fi
grep -q "mkfs.erofs" "$work/negative.log"
printf 'RUNTIME_RESULT digest=%s magic=%s git=%s tool=%s\\n' "$first" "$magic" "$git_version" "$tool_version"
`;

const AGENT_MOUNT = `set -euo pipefail
mkdir -p /tmp/mnt
erofsfuse /fixture/fixture.erofs /tmp/mnt
trap 'fusermount3 -u /tmp/mnt 2>/dev/null || true' EXIT
test "$(cat /tmp/mnt/hello.txt)" = "packaged-fixture"
fusermount3 -u /tmp/mnt
trap - EXIT
if grep -q " /tmp/mnt " /proc/self/mountinfo; then
  echo "MOUNT_REMAINED"
  exit 1
fi
printf 'RUNTIME_RESULT digest=%s helpers=%s fusermount=%s\\n' \\
  "$(cat /fixture/digest)" \\
  "$(command -v erofsfuse fusermount3 fuse-overlayfs | tr '\\n' ',')" \\
  "$(fusermount3 -V 2>&1 | head -1)"
`;

const AGENT_NEGATIVE = `set -euo pipefail
mkdir -p /tmp/mnt
# Make the unsupported-device context deterministic even on a runtime that
# happens to expose /dev/fuse to the container.
rm -f /dev/fuse
# erofsfuse can exit 0 after FUSE refuses to mount (for example with no
# /dev/fuse). The Agent's own guard therefore checks the mount table instead of
# trusting the helper status; this probe asserts that same fail-closed result.
erofsfuse /fixture/fixture.erofs /tmp/mnt 2>/tmp/erofs.log || true
if grep -q " /tmp/mnt " /proc/self/mountinfo; then
  echo "UNEXPECTED_MOUNT"
  exit 1
fi
if [ -e /tmp/mnt/hello.txt ]; then
  echo "UNEXPECTED_MOUNT_CONTENT"
  exit 1
fi
printf 'RUNTIME_RESULT negative_reason=%s\\n' "$(head -1 /tmp/erofs.log)"
`;

/**
 * Probe the runner for a usable unprivileged FUSE device before promising the
 * SC-02 mount proof. A runner without one keeps the criterion Pending with the
 * measured prerequisite, never a fabricated Pass.
 */
function probeFuseDevice() {
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--device', '/dev/fuse', 'debian:bookworm-slim', 'test', '-r', '/dev/fuse'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  if (result.error) {
    return { ok: false, reason: 'docker is unavailable: ' + result.error.message };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().split('\n').filter(Boolean).pop();
    return { ok: false, reason: stderr || 'the runner cannot expose /dev/fuse to a container' };
  }
  return { ok: true };
}

module.exports = {
  ROOT,
  SERVER_PROBE,
  AGENT_MOUNT,
  AGENT_NEGATIVE,
  guard,
  buildRuntimeTools,
  buildErofsUtilsBuilder,
  createFixture,
  removeFixture,
  runInImage,
  resultLine,
  probeFuseDevice,
};
