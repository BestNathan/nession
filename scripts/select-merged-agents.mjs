#!/usr/bin/env node
// Trusted merged-SHA SC-method router. It only selects explicit Agent-method
// obligations; legacy Issues without a Plan are not retroactively auto-run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptancePlanSection } from './acceptance-plan.mjs';
import { buildAcceptanceContext } from './acceptance-executor.mjs';

export function selectMergedAgentIssues({ issueNumbers, issues, stage, targetSha, runId }) {
  if (!['staging', 'post-merge'].includes(stage)) throw new Error('unsupported merged Agent stage');
  if (!/^[0-9a-f]{40}$/i.test(targetSha)) throw new Error('merged Agent target must be exact 40-character SHA');
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('invalid merged Agent run ID');
  if (!Array.isArray(issueNumbers) || !Array.isArray(issues)) throw new Error('Issues must be arrays');
  return issueNumbers.filter((number) => {
    const issue = issues.find((item) => Number(item.number) === number);
    if (!issue) throw new Error('missing trusted Requirement contract #' + number);
    if (acceptancePlanSection(issue.body) === null) return false;
    const context = buildAcceptanceContext(issue, stage, {
      targetRef: targetSha, runId, method: 'agent',
    });
    return context.criteria.length > 0;
  });
}

function fixturePlan() {
  const f = String.fromCharCode(96).repeat(3);
  return ['## Success Criteria',
    '- [ ] SC-01 merged staging Agent',
    '- [ ] SC-02 merged staging Case',
    '- [ ] SC-03 merged main Agent',
    '- [ ] SC-04 deployed Case',
    '', '## Acceptance Report', '| Criterion | Stage | Result | Evidence |',
    '|---|---|---|---|',
    '| SC-01 | staging | Pending | awaiting proof |',
    '| SC-02 | staging | Pending | awaiting proof |',
    '| SC-03 | post-merge | Pending | awaiting proof |',
    '| SC-04 | post-merge | Pending | awaiting production |',
    '', '## Acceptance Plan', f + 'yaml',
    'acceptance:',
    '  SC-01:', '    when: merged', '    branch: staging', '    method: agent',
    '  SC-02:', '    when: merged', '    branch: staging', '    method: case',
    '  SC-03:', '    when: merged', '    branch: main', '    method: agent',
    '  SC-04:', '    when: deployed', '    environment: production', '    method: case',
    f, '## Product alignment', '- [x] aligned', '**Status:** Approved',
  ].join('\n');
}

function selfTest() {
  const issue = { number: 42, title: 'Requirement: fixture', body: fixturePlan() };
  const base = { issueNumbers: [42], issues: [issue], targetSha: 'a'.repeat(40), runId: 10 };
  assert.deepEqual(selectMergedAgentIssues({ ...base, stage: 'staging' }), [42]);
  assert.deepEqual(selectMergedAgentIssues({ ...base, stage: 'post-merge' }), [42]);
  assert.deepEqual(selectMergedAgentIssues({ ...base, stage: 'staging',
    issues: [{ ...issue, body: issue.body.replace('method: agent', 'method: case') }] }), []);
  assert.deepEqual(selectMergedAgentIssues({ ...base, stage: 'staging',
    issues: [{ ...issue, body: issue.body.split('## Acceptance Plan')[0] }] }), []);
  assert.throws(() => selectMergedAgentIssues({ ...base, stage: 'deployed' }), /unsupported/);
  assert.throws(() => selectMergedAgentIssues({ ...base, stage: 'staging', targetSha: 'main' }), /exact/);
  assert.throws(() => selectMergedAgentIssues({ ...base, stage: 'staging', issues: [] }), /missing trusted/);
  console.log('merged Agent SC selection: exact SHA, method filtering, deployed exclusion, legacy compatibility passed');
}

function main() {
  const mode = process.argv[2];
  if (mode === 'self-test') return selfTest();
  if (mode !== 'select') throw new Error('usage: select-merged-agents.mjs <self-test|select ISSUE_JSON_DIR>');
  const issueDir = process.argv[3];
  if (!issueDir) throw new Error('Issue contract directory is required');
  const issueNumbers = JSON.parse(process.env.ISSUE_NUMBERS ?? '[]').map(Number);
  const issues = issueNumbers.map(number =>
    JSON.parse(fs.readFileSync(path.join(issueDir, number + '.json'), 'utf8')));
  console.log(JSON.stringify(selectMergedAgentIssues({
    issueNumbers, issues,
    stage: process.env.ACCEPTANCE_STAGE,
    targetSha: process.env.TARGET_SHA,
    runId: Number(process.env.GITHUB_RUN_ID),
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (err) { console.error(err); process.exitCode = 1; }
}
