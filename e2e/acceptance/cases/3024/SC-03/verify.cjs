'use strict';
// #3024 SC-03: with compatible Node and Rust EROFS bundles, an on-demand
// Sandbox executes node --version and compiles/runs a minimal Rust program.
//
// The mount composition and toolchain binding are implemented, but this lane
// does not yet have a bounded, reproducible Node/Rust bundle packager: copying
// a full Rust sysroot + linker into an EROFS image inside the 120s verifier
// budget is not proven. The Issue explicitly requires this criterion to stay
// Pending until the exact staging Case is executable; it is never Agent Pass.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checked } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

try {
  checked('sudo', ['apt-get', 'update', '-qq'], 120000);
  checked(
    'sudo',
    ['apt-get', 'install', '-y', '-qq', 'erofs-utils', 'erofsfuse', 'fuse3', 'fuse-overlayfs'],
    300000,
  );
} catch (error) {
  console.error('could not install EROFS helpers: ' + error.message);
}

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-erofs-accept-'));
process.env.SANDBOX_EROFS_IMAGE_ROOT = imageRoot;
const capabilities = probeCapabilities();
if (!capabilities.backend || !capabilities.erofs) {
  pending('The runner cannot mount prepared EROFS images', [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else {
  pending(
    'The exact Node/Rust EROFS bundle Case is not executable in this lane: no bounded ' +
      'bundle packager (rustc + linker + sysroot, node + runtime libs) exists yet',
    [{
      type: 'blocked',
      value:
        capabilityLine(capabilities) +
        '; toolchain bundle packaging remains a staging-lane prerequisite, not an Agent Pass',
    }],
  );
}
