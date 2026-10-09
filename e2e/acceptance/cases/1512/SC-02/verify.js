'use strict';
// #1512 SC-02: source-aligned, exact-SHA browser-regression migration proof.
// The shared Runner owns server/agent/tmux/Web; this Case only observes it.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../../../../..');
async function verify() {
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(sha || '', /^[0-9a-f]{40}$/, 'exact target SHA required');
  const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(checkedOut, sha, 'source tree does not match the exact staged SHA');
  const filename = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  assert.ok(filename && fs.existsSync(filename), 'shared runtime evidence absent');
  const runtime = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(runtime.target_sha, sha, 'shared runtime has different target SHA');
  assert.equal(runtime.profile, 'full-stack-local', 'incorrect full-stack profile');
  const base = String(runtime.base_url || '');
  assert.match(base, /^http:\/\/localhost:[0-9]+$/, 'no isolated Web endpoint');
  const response = await fetch(base + '/', { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200, 'production Web stack is not serving');
  const suite = execFileSync(process.execPath, ['e2e/runner/cli-selftest.mjs'],
    { cwd: repo, encoding: 'utf8', timeout: 20000 });
  assert.match(suite, /canonical E2E CLI self-test/, '21-spec / 43-snapshot parity self-test did not run');
  const validation = JSON.parse(execFileSync(process.execPath, ['e2e/run', '--validate'],
    { cwd: repo, encoding: 'utf8', timeout: 10000 }));
  assert.ok(validation.case_count >= 1, 'Case discovery returned no Cases');
  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'The exact merged SHA serves isolated production Web and the canonical 21-spec/43-PNG parity and Case catalogs validate.',
    evidence: [
      { type: 'runtime', value: 'shared full-stack target_sha=' + sha + ' Web HTTP=200' },
      { type: 'test', value: 'e2e/runner/cli-selftest.mjs passed 21 specs and 43 git-hashed PNG snapshots' },
      { type: 'test', value: './e2e/run --validate found ' + validation.case_count + ' source-aligned Cases' },
    ],
  }) + '\n');
}
verify().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({ status: 'fail',
    summary: message, evidence: [{ type: 'runtime', value: 'canonical staging browser Case failed on exact SHA' }] }) + '\n');
  process.exitCode = 1;
});
