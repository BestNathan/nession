'use strict';
// #3311 SC-02: the trusted post-merge scope verifier accepts a convergence
// plan carrying provenance with a correct digest, and still fails closed for
// a tampered digest or a selected plan with no digest.
const fs = require('node:fs');
const path = require('node:path');
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

run(({ evidence }) => {
  const sha = targetSha();

  checked('node', ['scripts/e2e-push-scope-artifact.mjs', 'self-test'], 120000);
  checked('node', ['scripts/acceptance-e2e-lineage.mjs', 'self-test'], 300000);

  const pushScope = read('scripts/e2e-push-scope-artifact.mjs');
  const lineage = read('scripts/acceptance-e2e-lineage.mjs');
  for (const [name, source] of [
    ['push-scope verifier', pushScope],
    ['Acceptance lineage verifier', lineage],
  ]) {
    if (!/import\s*\{[^}]*planDigest[^}]*\}\s*from\s*'\.\/issue-e2e-plan\.mjs'/.test(source)) {
      throw new Error('the ' + name + ' does not import the canonical digest owner');
    }
  }
  if (pushScope.includes('JSON.stringify(canonical)') || pushScope.includes('sha256(JSON.stringify')) {
    throw new Error('the push-scope verifier still re-derives the canonical plan object');
  }
  if (lineage.includes('createHash')) {
    throw new Error('the Acceptance lineage verifier still re-derives the plan digest');
  }

  const replay = `
import assert from 'node:assert/strict';
import { planDigest } from './scripts/issue-e2e-plan.mjs';
import { verifyScopeArtifact } from './scripts/e2e-push-scope-artifact.mjs';
const sha = 'a'.repeat(40);
const plan = {
  schema_version: 1, kind: 'issue_e2e_selection',
  base_sha: 'b'.repeat(40), target_sha: sha, issues: [],
  selected: [], mode: 'not-required',
  convergence: {
    source_head_sha: sha, main_sha: 'b'.repeat(40), lane_sha: 'd'.repeat(40),
    batch_digest: 'e'.repeat(64), risk: 'mixed',
  },
  source_event: 'push', merge_sha: sha, source_pr: 7,
  reason: 'authenticated-source-bound-convergence',
};
plan.plan_digest = planDigest(plan);
const run = { id: 42, run_attempt: 1, head_sha: sha };
const results = {
  schema_version: 1, kind: 'issue_e2e_test_results', scope: 'not-required',
  target_sha: sha, plan_digest: plan.plan_digest,
  run_id: 42, run_attempt: 1, results: [], status: 'NotRequired',
};
const scopeProof = { scope: 'not-required', receipt: { plan_mode: 'not-required' } };
assert.equal(verifyScopeArtifact({ plan, results, run, scopeProof }).scope, 'not-required');
assert.throws(() => verifyScopeArtifact({
  plan: { ...plan, plan_digest: 'b'.repeat(64) }, results, run, scopeProof,
}), /digest/);
const selected = { ...plan, mode: 'selected', selected: [{ id: 'login', owners: [] }] };
selected.plan_digest = planDigest(selected);
const selectedResults = { ...results, scope: 'selected' };
assert.throws(() => verifyScopeArtifact({
  plan: { ...selected, plan_digest: null }, results: selectedResults, run,
  scopeProof: { scope: 'selected', receipt: { selected_ids: ['login'] } },
}));
console.log('convergence-scope-artifact-ok');
`;
  const output = checked('node', ['--input-type=module', '-e', replay], 120000);
  if (!output.includes('convergence-scope-artifact-ok')) {
    throw new Error('the convergence scope-artifact replay did not complete');
  }

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the push-scope and Acceptance-lineage selftests pass, and both verifiers import the canonical planDigest owner instead of re-deriving the seven-field object',
  });
  evidence.push({
    type: 'runtime',
    value: 'a convergence plan carrying convergence/source_event/merge_sha/source_pr/reason with its canonical digest is accepted by the trusted post-merge verifier; a tampered digest and a selected plan with no digest are rejected',
  });
  return 'the trusted post-merge verifier accepts a correctly digested convergence plan and still fails closed on a tampered or missing digest';
});
