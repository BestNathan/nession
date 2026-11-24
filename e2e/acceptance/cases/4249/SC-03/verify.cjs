'use strict';
// #4249 SC-03 setup: install the unprivileged EROFS/FUSE helpers and measure
// the runner's real native capabilities. The restart/fallback proof needs a
// Linux Sandbox backend plus verified EROFS mounting; a runner without them
// reports Pending with the measured reason, never a mock Pass.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');
const { probeCapabilities, pending, capabilityLine } = require('../../../shared/sandbox-cases.cjs');

try {
  checked('sudo', ['apt-get', 'update', '-qq'], 100000);
  checked(
    'sudo',
    ['apt-get', 'install', '-y', '-qq', 'erofs-utils', 'erofsfuse', 'fuse3', 'fuse-overlayfs'],
    100000,
  );
} catch (error) {
  console.error('could not install the EROFS/FUSE helpers: ' + error.message);
}

process.env.SANDBOX_EROFS_IMAGE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nession-4249-sc03-'),
);
const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable, [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else if (!capabilities.erofs) {
  pending(
    'The runner cannot mount a verified EROFS toolchain through the shared MountManager; ' +
      'the native restart/fallback proof is blocked by the measured capability',
    [{ type: 'blocked', value: capabilityLine(capabilities) }],
  );
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    evidence.push({
      type: 'runtime',
      value: 'exact SHA ' + sha + ' setup: ' + capabilityLine(capabilities),
    });
    return 'EROFS/FUSE helpers installed and the native mount capability measured on the runner';
  });
}