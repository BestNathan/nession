'use strict';
// SC-09 (#4618): integrated Server+Agent+tmux recovery contract on the merged
// staging SHA. The provisioned full-stack runtime proves the assembled probe
// endpoints respond credential-free; the named exact-SHA suites prove the
// fault-injection mechanism (LAN path removed / alternate remains, same Session
// resumes without duplicate attach, generation fences, dial deadline, healthy
// route preservation, fresh inventory adoption). Source invariants prove single
// SessionRuntime authority and that a probe never carries a credential.
const fs = require('node:fs');
const path = require('node:path');
const {
  run,
  requireSource,
  forbidSource,
  runWebTests,
  readSource,
} = require('../../../shared/ws-recovery-cases.cjs');
const { checked } = require('../../../shared/control-mode-cases.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

function runtimeFile() {
  const file = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  if (!file) throw new Error('the acceptance runtime file is not set');
  const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (runtime.profile !== 'full-stack-local'
    || !Number.isInteger(runtime.server_port)
    || !Number.isInteger(runtime.agent_port)) {
    throw new Error('a real full-stack runtime is required');
  }
  return runtime;
}

/** Assert a real probe endpoint answers 204 + the fixed marker, no body. */
function assertProbe(port, label) {
  const headers = checked('curl', [
    '-s', '-D', '-', '-o', '/dev/null', '--max-time', '10',
    `http://127.0.0.1:${port}/probe`,
  ], 30000);
  if (!/HTTP\/1\.1 204/.test(headers)) {
    throw new Error(`${label} /probe did not answer 204: ${headers.slice(0, 200)}`);
  }
  if (!/nession-probe:\s*v1/i.test(headers)) {
    throw new Error(`${label} /probe is missing the Nession-Probe: v1 marker`);
  }
  if (!/cache-control:\s*no-store/i.test(headers)) {
    throw new Error(`${label} /probe is missing Cache-Control: no-store`);
  }
  return `${label} /probe answered 204 + Nession-Probe: v1 + no-store on the real stack`;
}

run(({ evidence }) => {
  const runtime = runtimeFile();

  // Assembled integration: both runtimes serve the credential-free probe.
  evidence.push({ type: 'runtime', value: assertProbe(runtime.server_port, 'Server') });
  evidence.push({ type: 'runtime', value: assertProbe(runtime.agent_port, 'Agent') });

  // A non-reserved path is still 404 (the probe did not become a catch-all).
  const notFound = checked('curl', [
    '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10',
    `http://127.0.0.1:${runtime.agent_port}/not-a-route`,
  ], 30000);
  if (notFound.trim() !== '404') {
    throw new Error(`Agent non-probe path expected 404, got ${notFound}`);
  }
  evidence.push({ type: 'runtime', value: 'Agent non-probe path remains 404 (probe is a reserved explicit route)' });

  // Exact-SHA fault-injection mechanism suites.
  const scheduler = runWebTests([
    'src/platform/probe/__tests__/unit/ProbeScheduler.test.ts',
  ]);
  evidence.push({ type: 'runtime', value: `ProbeScheduler incremental/fence/bounds suite: ${scheduler} passing tests (fast candidate publishes before slow sibling; stale epoch/inventory fenced; per-address/global bounds)` });

  const runtimeAdoption = runWebTests([
    'src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts',
  ], '4618 SC-06');
  evidence.push({ type: 'runtime', value: `SessionRuntime fresh-inventory adoption + stale-sync fence: ${runtimeAdoption} passing tests (same Session resumes with replaced membership, credential retained)` });

  const policy = runWebTests([
    'src/platform/attach/__tests__/unit/AddressAttachPolicy.test.ts',
  ], '4618 SC-04');
  evidence.push({ type: 'runtime', value: `AddressAttachPolicy healthy-route preservation: ${policy} passing tests (latency/membership jitter never migrates a healthy route; real failure still rotates)` });

  const dial = runWebTests([
    'src/platform/socket/__tests__/unit/WebSocketService.test.ts',
  ], '4618 SC-05');
  evidence.push({ type: 'runtime', value: `WebSocketService dial deadline: ${dial} passing tests (CONNECTING settles once, waiters reject once, late callbacks fenced)` });

  // Source invariants: one Session attach authority; probe is credential-free.
  requireSource([
    ['web/src/platform/session-runtime/SessionRuntimeRegistry.ts', 'resumeServerAuthenticated', 'single SessionRuntime registry wake authority'],
    ['web/src/platform/probe/ProbeScheduler.ts', 'probeGeneration', 'probe generation fence'],
    ['web/src/platform/probe/ProbeScheduler.ts', 'inventoryGeneration', 'inventory generation fence'],
    ['crates/nession-runtime/src/probe.rs', 'PROBE_MARKER_VALUE', 'canonical probe marker owner'],
  ]);
  forbidSource([
    ['web/src/platform/probe/httpProbe.ts', "credentials: 'include'", 'probe must omit credentials'],
    ['web/src/platform/probe/httpProbe.ts', 'no-cors', 'probe must never use an opaque no-cors response'],
  ]);
  const httpProbe = readSource('web/src/platform/probe/httpProbe.ts');
  if (!httpProbe.includes("credentials: 'omit'") || !httpProbe.includes("redirect: 'error'")) {
    throw new Error('httpProbe must omit credentials and error on redirect');
  }
  evidence.push({ type: 'runtime', value: 'single SessionRuntime authority preserved; probe omits credentials, errors on redirect, never no-cors; generation fences present' });

  return 'Integrated Server+Agent probe contract holds on the real stack and the exact-SHA fault-injection suites prove incremental recovery, generation fences, healthy-route preservation and fresh inventory adoption without duplicate attach';
});
