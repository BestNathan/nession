'use strict';
// #2748 SC-01: the trusted verification-tier matrix classifies root .gitignore
// as repository metadata. An otherwise classified tooling diff then needs no
// audit and keeps the scoped floor, while a genuinely unclassified path still
// fails closed.
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
  if (!policy.includes('.gitignore')) {
    throw new Error('the verification-tier policy does not classify .gitignore');
  }

  const replay = `
import { assessChangedPaths } from './scripts/verification-tier-policy.mjs';
const ignore = assessChangedPaths(['.gitignore']);
const tooling = assessChangedPaths(['.gitignore', 'scripts/seed-worktree-target.sh']);
const unknown = assessChangedPaths(['terraform/main.tf']);
const fail = (message) => { throw new Error(message); };
if (ignore.needsAudit || ignore.floor !== 'verification:scoped' || ignore.components.length !== 0) fail('a .gitignore-only diff did not classify as metadata');
if (tooling.needsAudit || tooling.components.join(',') !== 'build-policy') fail('a classified tooling diff with .gitignore required an audit');
if (!unknown.needsAudit) fail('an unclassified path no longer fails closed');
console.log(JSON.stringify({
  ignore: { floor: ignore.floor, needs_audit: ignore.needsAudit, components: ignore.components },
  tooling: { needs_audit: tooling.needsAudit, components: tooling.components },
  unknown: { needs_audit: unknown.needsAudit },
}));
`;
  const output = checked('node', ['--input-type=module', '-e', replay], 30000).trim();
  const parsed = JSON.parse(output.split('\n').filter(Boolean).pop());

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the verification-tier self-test passes; a .gitignore-only diff is ' +
      parsed.ignore.floor + ' with no components and no audit, and a classified tooling diff with ' +
      '.gitignore keeps components ' + parsed.tooling.components.join(',') + ' without an audit',
  });
  evidence.push({
    type: 'runtime',
    value: 'a genuinely unclassified path still requires an audit (fail-closed preserved)',
  });
  return 'root ignore rules are repository metadata for the verification-tier matrix; unclassified paths still fail closed';
});
