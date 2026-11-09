#!/usr/bin/env node
// #2031: PR acceptance dispatches on the PR event and never waits for
// Quality/E2E completion or blocks a merge. Their required checks live in CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root,file),'utf8');
const source = read('.github/workflows/acceptance-orchestrator.yml');
const background = read('.github/workflows/acceptance-orchestrator-background.yml');
const acceptor = read('.github/workflows/agent-sc-acceptance.yml');
const executor = read('scripts/acceptance-executor.mjs');
const extract = (text,name) => {
  const start = text.indexOf('\n  '+name+':\n');
  assert.ok(start>=0,'missing job '+name);
  const rest=text.slice(start+1);
  const next=rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next<0?rest:rest.slice(0,next+1);
};
function verify(workflow) {
  assert.match(workflow,/pull_request_target:\s*\n\s+branches: \[staging, main\]/);
  const prepare=extract(workflow,'prepare-pre-merge');
  const evaluate=extract(workflow,'pre-merge-acceptance');
  assert.match(prepare,/discover-pre-merge/);
  assert.match(prepare,/ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(prepare,/head_sha: \$\{\{ steps.context.outputs.head_sha \}\}/);
  assert.match(evaluate,/needs: prepare-pre-merge/);
  assert.match(evaluate,/has_requirements == 'true'/);
  assert.match(evaluate,/stage: pre-merge/);
  assert.match(evaluate,/target_ref: \$\{\{ needs.prepare-pre-merge.outputs.head_sha \}\}/);
  for(const obsolete of [
    'id: barrier','admission ==', 'acceptance-dependency-state.mjs',
    'acceptance-source-applicability.mjs','defer-pre-merge:',
    'reconcile-issue-e2e:','reconcile-completed-quality-e2e:',
    'pre-merge-gate:','acceptance-pr-gate:', 'workflow_run:',
    'nession-issue-e2e-projected','requirement-acceptance-pre-merge',
    'requirement-acceptance-pr','issue-e2e-gate.mjs',
  ])assert.ok(!workflow.includes(obsolete),'obsolete PR dependency/gate: '+obsolete);
  const bg=extract(workflow,'background');
  assert.match(bg,/acceptance-orchestrator-background.yml@main/);
  assert.match(bg,/github.event_name == 'issues'/);
  assert.match(bg,/github.event_name == 'push'/);
  assert.match(bg,/nession-agent-telemetry-ingested/);
}
verify(source);
for(const fragment of [
  '  defer-pre-merge:','  pre-merge-gate:',
  '  reconcile-completed-quality-e2e:','  workflow_run:',
  '      needs.prepare-pre-merge.outputs.admission ==',
])assert.throws(()=>verify(source+'\n'+fragment),/obsolete PR dependency\/gate/);
assert.match(background,/\n  acceptance-close-guard:/);
assert.match(background,/\n  merged-agent-acceptance:/);
assert.match(background,/\n  post-merge-provider-evidence-acceptance:/);
// Exactly two trusted Main exceptions are allowed in PR-stage CI evidence
// collection; all other PR-stage SCs keep their historical null evidence.
const assertScopedCollectors = text => {
  assert.ok(text.includes("if: inputs.stage != 'pre-merge' || (inputs.stage == 'pre-merge' && (inputs.issue_number == '2917' || inputs.issue_number == '3001'))"),
    'only source-pinned #2917 and #3001 may collect PR-stage evidence');
  assert.ok(text.includes('if [[ "${ACCEPTANCE_STAGE}" != "pre-merge" || "${ISSUE_NUMBER}" == 2917 || "${ISSUE_NUMBER}" == 3001 ]]; then'),
    'all other pre-merge contexts must omit CI evidence');
  assert.match(text,/node scripts\/acceptance-ci-evidence\.mjs collect-pr-quality/);
  assert.match(text,/node scripts\/acceptance-ci-evidence\.mjs collect-pr-fixture/);
};
assertScopedCollectors(acceptor);
assert.throws(()=>assertScopedCollectors(acceptor.replace("inputs.issue_number == '3001'","inputs.issue_number == '3002'")),
  /only source-pinned/);
assert.throws(()=>assertScopedCollectors(acceptor.replace('"${ISSUE_NUMBER}" == 3001','"${ISSUE_NUMBER}" == 3002')),
  /all other pre-merge/);
assert.match(acceptor,/ci_evidence_file="-"/);
assert.match(executor,/ciEvidenceFile === '-' \? null/);
assert.match(acceptor,/name: Apply Acceptance Report and checkbox projection/);
console.log('Acceptance PR route: immediate SC selection, no Quality/E2E barrier, no PR blocking Gate, merged/close routes and evidence separation verified');
