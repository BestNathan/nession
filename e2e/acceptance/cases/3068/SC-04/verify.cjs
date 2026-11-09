'use strict';
const { assert, inspect, test, proof } = require('../../../shared/acceptance-source-cases.cjs');
proof(({ evidence, sha }) => {
  const replay = [
    "import assert from 'node:assert/strict';",
    "import { buildAcceptanceContext } from './scripts/acceptance-executor.mjs';",
    "const issue=(body)=>({ number: 3068, title: 'fixture', body });",
    "const fence=String.fromCharCode(96).repeat(3);",
    "const base=['### Success Criteria','- [ ] SC-01 pinned source',",
    "'## Acceptance Plan',fence+'yaml','acceptance:','  SC-01:','    when: pr',",
    "'    method: agent',fence,'## Acceptance Report',",
    "'| Criterion | Stage | Result | Evidence |', '|---|---|---|---|',",
    "'| SC-01 | pre-merge | Pending | - |'].join('\\n');",
    "const make=(body)=>buildAcceptanceContext(issue(body),'pre-merge',{runId:7,targetRef:'b'.repeat(40),method:'agent'});",
    "const noSource=make(base);",
    "const declared=(s)=>base.replace('## Acceptance Report',",
    "'## Acceptance Sources\\nacceptance_sources:\\n  SC-01:\\n    - branch: prototype\\n      sha: '+s+'\\n      files:\\n        - demo-123/index.html\\n## Acceptance Report');",
    "const pinned=make(declared('a'.repeat(40)));",
    "const changed=make(declared('c'.repeat(40)));",
    "assert.notEqual(noSource.contract_sha256,pinned.contract_sha256);",
    "assert.notEqual(pinned.contract_sha256,changed.contract_sha256);",
    "assert.equal(noSource.acceptance_sources,undefined);",
    "assert.equal(pinned.acceptance_sources['SC-01'][0].sha,'a'.repeat(40));",
    "console.log('digest transition/legacy fixture passed');",
  ].join('\n');
  const output = test(['--input-type=module', '-e', replay]);
  assert.match(output, /digest transition\/legacy fixture passed/);
  const executor = inspect('scripts/acceptance-executor.mjs');
  assert.match(executor, /contract\.sources \? \{ criteria: canonical/);
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha +
    ': source SHA alteration changes contract digest, while no-source context remains unextended; stale source-backed reuse is blocked' });
  return 'SC source declarations are part of the canonical immutable Acceptance contract';
});
