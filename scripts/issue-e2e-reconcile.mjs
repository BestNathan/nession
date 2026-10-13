#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Deterministic replay/order guard for trusted Issue E2E Report publication.
// The higher-privilege caller must independently attest the source artifact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIssueE2E } from './issue-e2e-contract.mjs';

const SHA = /^[a-f0-9]{40}$/;
const RECEIPT = /^run ([1-9]\d*)\/([1-9]\d*), SHA ([a-f0-9]{40}), contract ([a-f0-9]{64}), plan ([a-f0-9]{64}), tests (\d+)\/(\d+) \(https:\/\/github\.com\/BestNathan\/nession\/actions\/runs\/([1-9]\d*)\)$/;

function evidence(row, digest) {
  if (row.result === 'Pending' && row.evidence === '-') return null;
  const match = row.evidence.match(RECEIPT);
  if (!match || match[1] !== match[8] || match[4] !== digest)
    throw Error('Issue E2E Report contains unauthenticated or mismatched evidence');
  const run = Number(match[1]), attempt = Number(match[2]);
  if (!Number.isSafeInteger(run) || !Number.isSafeInteger(attempt))
    throw Error('unsafe run identity in Issue E2E Report');
  return { run, attempt, sha: match[3], contract: match[4], plan: match[5] };
}
function outsideReport(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex(x => x.trim() === '## E2E Report');
  if (first < 0) throw Error('Issue E2E Report missing');
  let last = lines.findIndex((x, i) => i > first && /^##\s/.test(x));
  if (last < 0) last = lines.length;
  return [...lines.slice(0, first), '## E2E Report', '[TRUSTED REPORT]', ...lines.slice(last)]
    .join('\n').trim();
}
function order(a, b) {
  if (a.run !== b.run) return a.run - b.run;
  return a.attempt - b.attempt;
}
export function decideIssueE2EProjection(currentBody, candidateBody, { runId, attempt, targetSha }) {
  if (!Number.isSafeInteger(runId) || runId <= 0 ||
      !Number.isSafeInteger(attempt) || attempt <= 0 || !SHA.test(targetSha))
    throw Error('invalid trusted execution identity');
  const old = parseIssueE2E(currentBody, { requireDeclaration: true });
  const next = parseIssueE2E(candidateBody, { requireDeclaration: true });
  if (old.errors.length || next.errors.length || !old.selectedIds.length ||
      old.digest !== next.digest || old.selectedIds.join(',') !== next.selectedIds.join(','))
    throw Error('Issue E2E declaration mutated or invalid');
  if (outsideReport(currentBody) !== outsideReport(candidateBody))
    throw Error('projection attempted to rewrite non-E2E Issue content');
  const newReceipts = next.selectedIds.map(id => evidence(next.rows.get(id), next.digest));
  if (newReceipts.some(x => !x || x.run !== runId || x.attempt !== attempt || x.sha !== targetSha))
    throw Error('projected result is missing current run/SHA evidence');
  if (new Set(newReceipts.map(x => x.plan)).size !== 1)
    throw Error('inconsistent plan digest in E2E Report');
  const oldReceipts = old.selectedIds.map(id => evidence(old.rows.get(id), old.digest)).filter(Boolean);
  if (!oldReceipts.length) return 'apply';
  if (new Set(oldReceipts.map(x => x.run + '/' + x.attempt)).size !== 1)
    throw Error('mixed current run attempts in E2E Report');
  const previous = oldReceipts[0], incoming = {run: runId, attempt};
  const cmp = order(incoming, previous);
  if (cmp < 0) return 'stale';
  if (cmp === 0) {
    if (next.selectedIds.every(id => {
      const a = old.rows.get(id), b = next.rows.get(id);
      return a.result === b.result && a.evidence === b.evidence;
    })) return 'duplicate';
    throw Error('same-run divergent Issue E2E evidence');
  }
  return 'apply';
}
function selfTest() {
  const sha = 'a'.repeat(40);
  const plan = 'b'.repeat(64);
  const basis = [
    '## E2E Verification','### New','- none: no new browser test',
    '### Regression','- login','- session-lifecycle','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|',
  ];
  const receipt = (id, result, run, attempt = 1, target = sha) =>
    '| ' + id + ' | Regression | ' + result + ' | run ' + run + '/' + attempt +
    ', SHA ' + target + ', contract ' + digest + ', plan ' + plan +
    ', tests 1/1 (https://github.com/BestNathan/nession/actions/runs/' + run + ') |';
  const pending = basis.concat(
    '| login | Regression | Pending | - |',
    '| session-lifecycle | Regression | Pending | - |',
    '## Acceptance Report','original SC evidence').join('\n');
  const digest = parseIssueE2E(pending).digest;
  const result = (run, attempt, login = 'Fail', target = sha) =>
    basis.concat(receipt('login', login, run, attempt, target),
      receipt('session-lifecycle','Pass',run,attempt,target),
      '## Acceptance Report','original SC evidence').join('\n');
  const a = result(10,1), b = result(11,1,'Pass'), c = result(11,2,'Pass');
  const args = (run,attempt,target=sha) => ({runId:run,attempt,targetSha:target});
  assert.equal(decideIssueE2EProjection(pending,a,args(10,1)),'apply');
  assert.equal(decideIssueE2EProjection(a,b,args(11,1)),'apply');
  assert.equal(decideIssueE2EProjection(b,a,args(10,1)),'stale');
  assert.equal(decideIssueE2EProjection(b,b,args(11,1)),'duplicate');
  assert.equal(decideIssueE2EProjection(b,c,args(11,2)),'apply');
  assert.equal(decideIssueE2EProjection(c,b,args(11,1)),'stale');
  assert.throws(()=>decideIssueE2EProjection(b,result(11,1,'Fail'),args(11,1)),/divergent/);
  assert.throws(()=>decideIssueE2EProjection(b,result(12,1,'Pass','c'.repeat(40)),args(12,1)),/run\/SHA/);
  assert.throws(()=>decideIssueE2EProjection(b,result(12,1,'Pass').replace('original SC evidence','forged'),args(12,1)),/non-E2E/);
  assert.throws(()=>decideIssueE2EProjection(b,result(12,1,'Pass').replace('- login','- terminal-attach'),args(12,1)),/declaration/);
  console.log('Issue E2E reconciliation: replay, retry ordering, stale/duplicate, foreign SHA and forged SC negatives passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const [command,issueFile,projectionFile,run,attempt,sha] = process.argv.slice(2);
if(command==='self-test') selfTest();
else if(command==='decide'){
  if(!issueFile||!projectionFile)throw Error('decide ISSUE_JSON PROJECTED_JSON RUN ATTEMPT SHA');
  const old = JSON.parse(fs.readFileSync(issueFile,'utf8'));
  const next = JSON.parse(fs.readFileSync(projectionFile,'utf8'));
  const decision = decideIssueE2EProjection(old.body,next.body,
    {runId:Number(run),attempt:Number(attempt),targetSha:sha});
  process.stdout.write(decision+'\n');
}else throw Error('usage: issue-e2e-reconcile.mjs self-test | decide ISSUE PROJECTED RUN ATTEMPT SHA');
}
