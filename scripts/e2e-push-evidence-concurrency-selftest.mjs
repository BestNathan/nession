#!/usr/bin/env node
// #1690: a successful main Push is durable source evidence, not an obsolete PR
// check. A newer main Push must NEVER cancel/purge the prior main SHA run.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const producerWorkflows=[
  ['.github/workflows/e2e-tests.yml','e2e'],
  ['.github/workflows/e2e-scenario-smoke.yml','e2e-scenario'],
];
function auditSourceRunIsolation(source,prefix){
  const group=source.match(/^  group: (.+)$/m)?.[1];
  const cancel=source.match(/^  cancel-in-progress: (.+)$/m)?.[1];
  const wantedGroup=prefix+'-'+'$'+"{{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}";
  const wantedCancel='$'+"{{ github.event_name == 'pull_request' }}";
  assert.equal(group,wantedGroup,'untrusted/superseded PRs must be deduplicated but each main Push uses its own run ID');
  assert.equal(cancel,wantedCancel,'no main Push source evidence may be cancelled by a newer SHA');
  assert.match(source,/^  push:\n    branches: \[.*main.*\]/m,'missing main source trigger');
}
for(const [file,prefix] of producerWorkflows){
  const source=fs.readFileSync(file,'utf8');
  auditSourceRunIsolation(source,prefix);
  assert.throws(()=>auditSourceRunIsolation(source.replace(
    /^  cancel-in-progress: .+$/m,'  cancel-in-progress: true'),prefix),
    /no main Push source evidence/);
  assert.throws(()=>auditSourceRunIsolation(source.replace(
    /^  group: .+$/m,'  group: '+prefix+'-'+'$'+'{{ github.ref_name }}'),prefix),
    /each main Push uses its own run ID/);
}
console.log('Run Store source cancellation Gate: PR supersession only; main Push E2E and Scenario runs retain separate immutable source identities');
