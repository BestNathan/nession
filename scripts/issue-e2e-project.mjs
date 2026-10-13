#!/usr/bin/env node
// Pure trusted projection owner for Issue E2E Report; GitHub mutations must be
// performed only by main-owned ingestion after independent source attestation.
import assert from 'node:assert/strict';
import { parseIssueE2E } from './issue-e2e-contract.mjs';

const RESULTS = new Set(['Pass', 'Fail', 'Pending', 'Error']);
const HEX40 = /^[0-9a-f]{40}$/;
function reportTable(rows) {
  return ['| ID | Type | Result | Evidence |','|---|---|---|---|',
    ...rows.map(row => '| ' + row.id + ' | ' + row.type + ' | ' + row.result + ' | ' + row.evidence + ' |')].join('\n');
}
export function projectIssueE2E(issue, plan, execution, authenticated) {
  if (!issue || !Number.isSafeInteger(issue.number) || !issue.body) throw new Error('invalid Issue');
  if (!plan || !Array.isArray(plan.issues) || !Array.isArray(plan.selected) || !execution ||
      !Array.isArray(execution.results) || plan.plan_digest !== execution.plan_digest ||
      plan.target_sha !== execution.target_sha || !HEX40.test(plan.target_sha)) {
    throw new Error('source plan/result provenance mismatch');
  }
  if (!authenticated || authenticated.target_sha !== plan.target_sha ||
      !Number.isSafeInteger(authenticated.run_id) || authenticated.run_id <= 0 ||
      !Number.isSafeInteger(authenticated.run_attempt) || authenticated.run_attempt <= 0 ||
      !authenticated.workflow_verified) throw new Error('missing trusted workflow_run attestation');
  const current = parseIssueE2E(issue.body, { requireDeclaration: true });
  if (current.errors.length) throw new Error('invalid current Issue E2E contract');
  const owner = plan.issues.find(x => x.issue === issue.number);
  if (!owner || current.digest !== owner.declaration_digest) throw new Error('stale Issue E2E declaration');
  const resultById = new Map();
  for (const result of execution.results) {
    if (resultById.has(result.id)) throw new Error('duplicate execution result ID');
    if (!RESULTS.has(result.result)) throw new Error('unsupported per-ID execution result');
    if (result.result === 'Pass' && (result.discovered <= 0 || result.passed !== result.discovered ||
        result.skipped !== 0 || result.flaky !== 0 || result.failed !== 0 || result.assertions <= 0)) {
      throw new Error('unproven E2E Pass for ' + result.id);
    }
    resultById.set(result.id, result);
  }
  const selected = new Set(plan.selected.map(row => row.id));
  for (const id of resultById.keys()) if (!selected.has(id)) throw new Error('undeclared per-ID result: ' + id);
  const rows = [];
  for (const id of current.selectedIds) {
    if (!selected.has(id)) throw new Error('required E2E ID missing from plan: ' + id);
    const result = resultById.get(id);
    if (!result) throw new Error('required E2E ID missing from execution: ' + id);
    const type = current.newIds.includes(id) ? 'New' : 'Regression';
    const runUrl = 'https://github.com/BestNathan/nession/actions/runs/' + authenticated.run_id;
    rows.push({ id, type, result: result.result,
      evidence: 'run ' + authenticated.run_id + '/' + authenticated.run_attempt +
        ', SHA ' + authenticated.target_sha.slice(0, 12) + ', ' +
        'tests ' + result.passed + '/' + result.discovered + ' (' + runUrl + ')' });
  }
  // Preserve non-E2E Issue data verbatim. Only the result section is projected.
  const lines = issue.body.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(line => line.trim() === '## E2E Report');
  if (start < 0) throw new Error('E2E Report section not found');
  let end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const updated = [...lines.slice(0, start + 1), '', reportTable(rows), '', ...lines.slice(end)].join('\n');
  return { body: updated, rows, all_pass: rows.every(r => r.result === 'Pass') };
}
function selfTest() {
  const body = [
    '## E2E Verification','### New','- terminal-resume','### Regression','- terminal-attach',
    '## E2E Report','| ID | Type | Result | Evidence |','|---|---|---|---|',
    '| terminal-resume | New | Pending | - |','| terminal-attach | Regression | Pending | - |',
    '## Acceptance Report','keep existing SC evidence',
  ].join('\n');
  const issue={number:13,body};
  const contract=parseIssueE2E(body);
  const sha='a'.repeat(40);
  const plan={target_sha:sha,plan_digest:'b'.repeat(64),issues:[{issue:13,declaration_digest:contract.digest}],
    selected:[{id:'terminal-resume'},{id:'terminal-attach'}]};
  const evidence={target_sha:sha,run_id:456,run_attempt:2,workflow_verified:true};
  const success={id:'terminal-attach',result:'Pass',discovered:1,passed:1,failed:0,flaky:0,skipped:0,assertions:3};
  const failure={id:'terminal-resume',result:'Fail',discovered:1,passed:0,failed:1,flaky:0,skipped:0,assertions:2};
  const execution={target_sha:sha,plan_digest:plan.plan_digest,results:[success,failure]};
  const result=projectIssueE2E(issue,plan,execution,evidence);
  assert.equal(result.all_pass,false);
  assert.match(result.body,/terminal-attach \| Regression \| Pass/);
  assert.match(result.body,/terminal-resume \| New \| Fail/);
  assert.match(result.body,/keep existing SC evidence/);
  assert.throws(() => projectIssueE2E(issue,plan,execution,{...evidence,workflow_verified:false}),/attestation/);
  assert.throws(() => projectIssueE2E(issue,plan,{...execution,plan_digest:'c'},evidence),/provenance/);
  assert.throws(() => projectIssueE2E({...issue,body:body.replace('- terminal-resume','- another-test')},plan,execution,evidence),/stale/);
  assert.throws(() => projectIssueE2E(issue,plan,{...execution,results:[{...success,assertions:0},failure]},evidence),/unproven/);
  assert.throws(() => projectIssueE2E(issue,plan,{...execution,results:[success]},evidence),/missing from execution/);
  console.log('Issue E2E projector: Pass/Fail, stale, untrusted, zero-assertion, incomplete negatives passed');
}
if (process.argv[2] === 'self-test') selfTest();
