'use strict';
// #3070 SC-01: the trusted verification-tier matrix classifies the root
// AGENTS.md as repository instruction metadata. A diff that touches it needs no
// audit, while the same file name in an unmapped directory and every genuinely
// unclassified path still fail closed.
const fs = require('node:fs');
const path = require('node:path');
const {
  run, checked, targetSha,
} = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');

run(({ evidence }) => {
  const sha = targetSha();
  checked('node', ['scripts/verification-tier-policy.mjs', 'self-test'], 30000);

  const policy = fs.readFileSync(path.join(root, 'scripts/verification-tier-policy.mjs'), 'utf8');
  if (!policy.includes('AGENTS\\.md$')) {
    throw new Error('the verification-tier metadata rule does not classify the root AGENTS.md');
  }

  const replay = `
import { assessChangedPaths } from './scripts/verification-tier-policy.mjs';
const docs = assessChangedPaths(['AGENTS.md']);
const tooling = assessChangedPaths(['AGENTS.md', 'scripts/verification-tier-policy.mjs']);
const merged = assessChangedPaths([
  'AGENTS.md',
  'Cargo.lock',
  'crates/nession-protocol/src/contracts/sandbox/v1.rs',
  'crates/nession-sandbox/src/lib.rs',
  'e2e/acceptance/cases/3070/SC-01/verify.cjs',
]);
const nested = assessChangedPaths(['unmapped/AGENTS.md']);
const unknown = assessChangedPaths(['terraform/main.tf']);
const fail = (message) => { throw new Error(message); };
if (docs.needsAudit || docs.floor !== 'verification:scoped' || docs.components.length !== 0)
  fail('a root AGENTS.md-only diff did not classify as metadata');
if (tooling.needsAudit || tooling.components.join(',') !== 'build-policy')
  fail('a classified tooling diff with AGENTS.md required an audit');
if (merged.needsAudit)
  fail('a merged diff that includes AGENTS.md still required an audit');
if (!nested.needsAudit)
  fail('a same-named file in an unmapped directory no longer fails closed');
if (!unknown.needsAudit)
  fail('an unclassified path no longer fails closed');
console.log(JSON.stringify({
  docs: { floor: docs.floor, needs_audit: docs.needsAudit, components: docs.components },
  tooling: { needs_audit: tooling.needsAudit, components: tooling.components },
  merged: { floor: merged.floor, needs_audit: merged.needsAudit, components: merged.components },
  nested: { needs_audit: nested.needsAudit },
  unknown: { needs_audit: unknown.needsAudit },
}));
`;
  const output = checked('node', ['--input-type=module', '-e', replay], 30000).trim();
  const parsed = JSON.parse(output.split('\n').filter(Boolean).pop());

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the verification-tier self-test passes; a root AGENTS.md-only diff is ' +
      parsed.docs.floor + ' with no components and no audit, and a classified tooling diff with ' +
      'AGENTS.md keeps components ' + parsed.tooling.components.join(',') + ' without an audit',
  });
  evidence.push({
    type: 'runtime',
    value: 'a merged diff containing AGENTS.md plus protocol/crate/e2e paths stays audit-free at floor ' +
      parsed.merged.floor + ', while unmapped/AGENTS.md and a genuinely unclassified path still require an audit (fail-closed preserved)',
  });
  return 'root AGENTS.md is repository metadata for the verification-tier matrix; nested names and unclassified paths still fail closed';
});
