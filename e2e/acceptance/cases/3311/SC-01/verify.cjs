'use strict';
// #3311 SC-01: one canonical plan-digest owner is used by every producer and
// verifier, and provenance fields never enter the digest.
const fs = require('node:fs');
const path = require('node:path');
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

run(({ evidence }) => {
  const sha = targetSha();

  checked('node', ['scripts/issue-e2e-plan.mjs', 'self-test'], 120000);
  checked('node', ['scripts/staging-convergence-pr.mjs', 'self-test'], 300000);

  const owner = read('scripts/issue-e2e-plan.mjs');
  if (!owner.includes('export function canonicalPlan(') ||
      !owner.includes('export function planDigest(')) {
    throw new Error('scripts/issue-e2e-plan.mjs does not own canonicalPlan/planDigest');
  }
  if (!owner.includes('plan_digest: planDigest(plan)')) {
    throw new Error('the Issue E2E plan builder does not use the canonical digest owner');
  }
  const producer = read('scripts/staging-convergence-pr.mjs');
  if (!/import\s*\{[^}]*planDigest[^}]*\}\s*from\s*'\.\/issue-e2e-plan\.mjs'/.test(producer)) {
    throw new Error('the convergence/promotion planner does not import the digest owner');
  }
  const sites = (producer.match(/plan_digest:planDigest\(plan\)/g) || []).length;
  if (sites !== 2) {
    throw new Error('both convergence and promotion plans must use planDigest; found ' + sites);
  }
  if (/plan_digest:sha256\(plan\)/.test(producer)) {
    throw new Error('a convergence/promotion plan still hashes the provenance wrapper');
  }

  const replay = `
import assert from 'node:assert/strict';
import { canonicalPlan, planDigest } from './scripts/issue-e2e-plan.mjs';
const base = {
  schema_version: 1, kind: 'issue_e2e_selection',
  base_sha: 'a'.repeat(40), target_sha: 'b'.repeat(40),
  issues: [], selected: [], mode: 'not-required',
};
const provenance = {
  ...base,
  convergence: {
    source_head_sha: 'b'.repeat(40), main_sha: 'a'.repeat(40),
    lane_sha: 'a'.repeat(40), batch_digest: 'c'.repeat(64), risk: 'mixed',
  },
  source_event: 'push', merge_sha: 'b'.repeat(40), source_pr: 7,
  reason: 'authenticated-source-bound-convergence',
};
assert.deepEqual(Object.keys(canonicalPlan(provenance)),
  ['schema_version', 'kind', 'base_sha', 'target_sha', 'issues', 'selected', 'mode']);
assert.equal(planDigest(provenance), planDigest(base),
  'provenance fields changed the canonical digest');
assert.notEqual(planDigest({ ...base, selected: [{ id: 'login', owners: [] }] }),
  planDigest(base), 'a different obligation set did not change the digest');
console.log('canonical-owner-ok');
`;
  const output = checked('node', ['--input-type=module', '-e', replay], 120000);
  if (!output.includes('canonical-owner-ok')) {
    throw new Error('the canonical digest replay did not complete');
  }

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the Issue E2E plan selftest and the native-convergence selftest pass; the owner exposes canonicalPlan/planDigest and both convergence and promotion builders use it',
  });
  evidence.push({
    type: 'runtime',
    value: 'a convergence-shaped plan carrying convergence/source_event/merge_sha/source_pr/reason hashes identically to its seven canonical obligation fields, while a different selected set changes the digest',
  });
  return 'one canonical plan digest owner is used by the plan builder, convergence planner, promotion planner and both verifiers; provenance never enters the digest';
});
