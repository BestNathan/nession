'use strict';
// Shared machinery for the #3022 EROFS Image Manager Cases.
//
// The Cases name exact Rust tests at the target checkout. This module owns only
// the external-tool provisioning (erofs-utils on the PR runner) and the cargo
// invocation; it does not decide what a criterion means.
const { spawnSync } = require('node:child_process');
const { checked } = require('./control-mode-cases.cjs');

function mkfsVersion() {
  const probe = spawnSync('mkfs.erofs', ['--help'], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  if (probe.status === 0) {
    return String(probe.stdout || probe.stderr).split('\n')[0].trim() || 'mkfs.erofs';
  }
  // Ubuntu 24.04 GitHub runners allow passwordless sudo. Install the tool
  // rather than silently skipping the only real EROFS proof.
  checked('sudo', ['apt-get', 'update'], 180000, { DEBIAN_FRONTEND: 'noninteractive' });
  checked('sudo', ['apt-get', 'install', '-y', 'erofs-utils'], 180000, {
    DEBIAN_FRONTEND: 'noninteractive',
  });
  const installed = spawnSync('mkfs.erofs', ['--help'], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  if (installed.status !== 0) throw new Error('erofs-utils installation did not provide mkfs.erofs');
  return String(installed.stdout || installed.stderr).split('\n')[0].trim() || 'mkfs.erofs';
}

/** Run a normal cargo test filter and return combined output. */
function runCargoTests(pkg, filter, timeout = 600000) {
  return checked('cargo', ['test', '-p', pkg, filter, '--', '--nocapture'], timeout);
}

/** Run one ignored real-tool test by its exact path. */
function runIgnoredCargoTest(pkg, exactName, timeout = 600000) {
  return checked(
    'cargo',
    ['test', '-p', pkg, exactName, '--', '--ignored', '--exact', '--nocapture'],
    timeout,
  );
}

module.exports = { mkfsVersion, runCargoTests, runIgnoredCargoTest };
