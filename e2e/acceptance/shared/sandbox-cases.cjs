'use strict';
// Shared machinery for the #2681 Sandbox Cases.
//
// The capability probe is a real host measurement performed by the same
// `nession-sandbox` build at the target SHA. A Case whose mechanism is absent
// reports Pending with the measured reason; it never substitutes a different
// OS, a mock, or a source review for the missing native proof.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checked } = require('./control-mode-cases.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const CAPABILITIES_PREFIX = 'NESSON_SANDBOX_CAPABILITIES ';
const EVIDENCE_PREFIX = 'NESSON_SANDBOX_EVIDENCE ';

/** Build the sandbox binaries and read the host's measured capabilities. */
function probeCapabilities() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-sandbox-accept-'));
  try {
    checked('cargo', ['build', '-q', '-p', 'nession-sandbox', '--bins'], 600000);
    const output = checked(
      'cargo',
      [
        'run', '-q', '-p', 'nession-sandbox', '--bin', 'nession-sandbox-probe',
        '--', '--state-dir', stateDir,
      ],
      300000,
    );
    const line = output
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(CAPABILITIES_PREFIX));
    if (!line) {
      throw new Error('the sandbox probe emitted no capabilities line: ' + output.slice(-2500));
    }
    return JSON.parse(line.slice(CAPABILITIES_PREFIX.length));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

/** Run one named test from the Linux runtime proof. */
function runLinuxRuntimeTest(name) {
  const output = checked(
    'cargo',
    ['test', '-p', 'nession-sandbox', '--test', 'linux_runtime', name, '--', '--nocapture'],
    900000,
  );
  if (!output.includes(name + ' ... ok')) {
    throw new Error('the Linux runtime proof did not run: ' + name + '\n' + output.slice(-3500));
  }
  return output;
}

/** Parse the concrete facts the runtime proof printed after verification. */
function runtimeEvidence(output) {
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(EVIDENCE_PREFIX));
  if (!line) throw new Error('the runtime proof printed no NESSION_SANDBOX_EVIDENCE line');
  return JSON.parse(line.slice(EVIDENCE_PREFIX.length));
}

/** Emit an honest Pending result with the measured prerequisite. */
function pending(summary, evidence) {
  process.stdout.write(JSON.stringify({
    status: 'pending',
    summary,
    evidence: evidence || [{ type: 'blocked', value: 'the required native capability was not measured on this runner' }],
  }) + '\n');
}

/** A one-line capability description for evidence. */
function capabilityLine(capabilities) {
  return 'platform=' + capabilities.platform +
    ' backend=' + (capabilities.backend || 'unavailable: ' + (capabilities.unavailable || 'unknown')) +
    ' namespaces=' + JSON.stringify(capabilities.namespaces) +
    ' seccomp=' + capabilities.seccomp +
    ' filesystem=' + capabilities.filesystem +
    ' erofs=' + capabilities.erofs +
    ' erofs_overlay=' + capabilities.erofs_overlay +
    ' network_deny=' + capabilities.network_deny +
    ' network_restricted=' + capabilities.network_restricted +
    ' cgroup_v2=' + (capabilities.cgroup_v2
      ? JSON.stringify(capabilities.cgroup_v2.controllers)
      : 'unavailable');
}

module.exports = {
  ROOT,
  probeCapabilities,
  runLinuxRuntimeTest,
  runtimeEvidence,
  pending,
  capabilityLine,
};
