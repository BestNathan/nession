import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIssueUpdateTool, enforceE2EReadOnly, completeIssueUpdateProposal } from './update.mjs';
import { applyIssueAuditProposal } from '../../../tasks/issue-audit.mjs';
import { createIssueReadTool } from './read.mjs';
import { createIssueCommentTool } from './comment.mjs';
import { parseIssueE2E } from '../../../../../issue-e2e-contract.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'nession-agent-gh-'));
const filename = path.join(tmp, 'issue.json');
const oldPath = process.env.PATH;
const oldFile = process.env.FAKE_GH_ISSUE_FILE;
const issue = {
  number: 17, state: 'OPEN', title: 'Requirement: old',
  labels: [{ name: 'requirement' }, { name: 'ci' }, { name: 'in-progress' }],
  body: '## Requirements: old\n\n### Success Criteria\n- [ ] SC-01 works\n\n## Acceptance Report\n| Criterion | Stage | Result | Evidence |\n|---|---|---|---|\n| SC-01 | pre-merge | Pending | implementation pending |\n\n## Product alignment\n- [x] aligned\n\n**Status:** Approved',
};
const fake = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  'const args = process.argv.slice(2);',
  'const file = process.env.FAKE_GH_ISSUE_FILE;',
  "const issue = JSON.parse(fs.readFileSync(file, 'utf8'));",
  "if (args[0] !== 'issue' || args[2] !== String(issue.number)) process.exit(2);",
  "if (args[1] === 'view') { console.log(JSON.stringify(issue)); process.exit(0); }",
  "if (args[1] === 'edit') {",
  "  const field = (name) => args[args.indexOf(name) + 1];",
  "  issue.title = field('--title');",
  "  issue.body = fs.readFileSync(0, 'utf8');",
  "  const labels = new Set(issue.labels.map((x) => x.name));",
  "  if (args.includes('--add-label')) for (const label of field('--add-label').split(',')) labels.add(label);",
  "  if (args.includes('--remove-label')) for (const label of field('--remove-label').split(',')) labels.delete(label);",
  "  issue.labels = [...labels].map((name) => ({ name }));",
  "  fs.writeFileSync(file, JSON.stringify(issue));",
  "  process.exit(0);",
  '}',
  "if (args[1] === 'comment') { fs.writeFileSync(file + '.comment', fs.readFileSync(0, 'utf8')); process.exit(0); }",
  'process.exit(2);',
].join('\n');
try {
  writeFileSync(filename, JSON.stringify(issue));
  writeFileSync(path.join(tmp, 'gh'), fake);
  chmodSync(path.join(tmp, 'gh'), 0o755);
  process.env.PATH = tmp + path.delimiter + oldPath;
  process.env.FAKE_GH_ISSUE_FILE = filename;

  const read = createIssueReadTool(issue, 'example/repo');
  const update = createIssueUpdateTool(issue, 'example/repo');
  const comment = createIssueCommentTool(issue, 'example/repo');
  assert.equal(JSON.parse(await read.execute({})).number, 17);
  await assert.rejects(read.execute({ number: 18 }), /Unauthorized/);
  await assert.rejects(update.execute({ title: 'Requirement: fail', body: issue.body, labels: ['requirement', 'ci'], issue_number: 18 }), /Unauthorized/);
  await assert.rejects(update.execute({ title: 'unformatted', body: issue.body, labels: ['requirement', 'ci'] }), /Contract validation failed/);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).title, 'Requirement: old');
  await update.execute({ title: 'Requirement: fixed', body: issue.body, labels: ['requirement', 'backend'] });
  const after = JSON.parse(readFileSync(filename, 'utf8'));
  assert.equal(after.title, 'Requirement: fixed');
  assert.deepEqual(after.labels.map((item) => item.name).sort(), ['backend', 'in-progress', 'requirement']);

  // Regression #2715 / live #41746058532: a valid labels-only Qwen
  // proposal MUST NOT pass undefined title/body into the full-field tool.
  // All mutations below go through the real Audit adapter and fake gh CLI.
  const beforePartial = JSON.parse(readFileSync(filename, 'utf8'));
  assert.deepEqual(completeIssueUpdateProposal(beforePartial, {labels:['requirement','ci']}),
    {title:beforePartial.title,body:beforePartial.body,labels:['requirement','ci']});
  assert.deepEqual(completeIssueUpdateProposal(beforePartial, {title:'Requirement: renamed'}),
    {title:'Requirement: renamed',body:beforePartial.body,labels:['requirement','backend']});
  await applyIssueAuditProposal(issue, {result:JSON.stringify({labels:['requirement','ci']})}, 'example/repo');
  const labelsOnly = JSON.parse(readFileSync(filename, 'utf8'));
  assert.equal(labelsOnly.title, beforePartial.title);
  assert.equal(labelsOnly.body, beforePartial.body);
  assert.deepEqual(labelsOnly.labels.map(x=>x.name).sort(),['ci','in-progress','requirement']);

  await applyIssueAuditProposal(issue,
    {result:JSON.stringify({title:'Requirement: renamed by audit'})},'example/repo');
  const titleOnly = JSON.parse(readFileSync(filename,'utf8'));
  assert.equal(titleOnly.title,'Requirement: renamed by audit');
  assert.equal(titleOnly.body, beforePartial.body);
  assert.deepEqual(titleOnly.labels,labelsOnly.labels);

  const revisedBody=titleOnly.body+'\n\nAdditional rationale retained.';
  await applyIssueAuditProposal(issue,
    {result:JSON.stringify({body:revisedBody})},'example/repo');
  const bodyOnly=JSON.parse(readFileSync(filename,'utf8'));
  assert.equal(bodyOnly.title,titleOnly.title);
  assert.equal(bodyOnly.body,revisedBody);
  assert.deepEqual(bodyOnly.labels,labelsOnly.labels);

  const beforeInvalid=readFileSync(filename,'utf8');
  await assert.rejects(applyIssueAuditProposal(issue,
    {result:JSON.stringify({labels:['requirement','noncanonical']})},'example/repo'),
    /canonical kind\/area labels/);
  await assert.rejects(applyIssueAuditProposal(issue,
    {result:JSON.stringify({title:' '})},'example/repo'),/non-empty strings/);
  await assert.rejects(applyIssueAuditProposal(issue,
    {result:JSON.stringify({issue_number:18,labels:['requirement','ci']})},'example/repo'),
    /unauthorized fields/);
  assert.equal(readFileSync(filename,'utf8'),beforeInvalid,'rejected proposals cannot edit the Issue');

  // #2818: a missing-label target requires a complete canonical proposal.
  // Exercise the real audit adapter and trusted update boundary; invalid
  // proposals must never reach fake gh issue edit or post a model comment.
  const savedIssue=readFileSync(filename,'utf8');
  const unlabelled={
    number:17,state:'OPEN',title:'Bug: missing labels',labels:[],
    body:'## Description\nObserved.\n\n## Reproduction\n1. Reproduce.\n\n## Investigation Status\nPending investigation.\n\n## Impact\nAffected.\n\n## Fix Direction\nRepair metadata.\n\n## Location\n- scripts/issue-audit-agent.mjs',
  };
  writeFileSync(filename,JSON.stringify(unlabelled));
  const absentLabelSnapshot=readFileSync(filename,'utf8');
  for (const [labels,reason] of [
    [['bug','ci','ci'],/duplicate/],
    [['bug','ci','verification:scoped'],/noncanonical/],
    [['bug',23,'ci'],/non_string/],
    [['bug','requirement','ci'],/kind_count/],
    [['ci'],/kind_count/],
    [['bug'],/missing_area/],
    ['bug',/not_array/],
  ]) {
    await assert.rejects(
      applyIssueAuditProposal(issue,{result:JSON.stringify({
        labels, comment:'must not post',verification_tier:null,
      })},'example/repo'), reason,
    );
    assert.equal(readFileSync(filename,'utf8'),absentLabelSnapshot,
      'invalid Issue Audit proposal must not mutate the target');
  }
  await assert.rejects(applyIssueAuditProposal(issue,
    {result:JSON.stringify({title:'Bug: renamed without labels'})},'example/repo'),
    /kind_count/);
  assert.equal(readFileSync(filename,'utf8'),absentLabelSnapshot);
  assert.deepEqual(completeIssueUpdateProposal(unlabelled,{labels:['bug','cli']}),
    {title:unlabelled.title,body:unlabelled.body,labels:['bug','cli']});
  await applyIssueAuditProposal(issue,
    {result:JSON.stringify({labels:['bug','cli']})},'example/repo');
  const repairedNoLabels=JSON.parse(readFileSync(filename,'utf8'));
  assert.deepEqual(repairedNoLabels.labels.map(x=>x.name).sort(),['bug','cli']);
  assert.equal(repairedNoLabels.title,unlabelled.title);
  assert.equal(repairedNoLabels.body,unlabelled.body);
  writeFileSync(filename,savedIssue);

  await assert.rejects(comment.execute({ body: 'ok', issue_number: 18 }), /Unauthorized/);
  await comment.execute({ body: 'investigation trail' });
  assert.equal(readFileSync(filename + '.comment', 'utf8'), 'investigation trail');
  const e2eContract = [
    '## E2E Verification', '### New', '- none: no new E2E tests',
    '### Regression', '- terminal-attach',
    '## E2E Report', '| ID | Type | Result | Evidence |',
    '|---|---|---|---|', '| terminal-attach | Regression | Pending | - |',
  ].join('\n');
  enforceE2EReadOnly(e2eContract,e2eContract);
  assert.throws(() => enforceE2EReadOnly(e2eContract,
    e2eContract.replace('| Pending | - |','| Pass | forged |')),/Unauthorized E2E/);
  assert.throws(() => enforceE2EReadOnly(e2eContract,
    e2eContract.replace('- terminal-attach','- terminal-replay')
      .replace('| terminal-attach | Regression','| terminal-replay | Regression')),/Unauthorized E2E/);
  assert.throws(() => enforceE2EReadOnly(issue.body,issue.body+'\n'+e2eContract),/Unauthorized E2E/);

  // #2851: invalid source format must enter repair, never be treated as an
  // unauthorized write. The fixed proposal must still pass full validation.
  const malformedE2e=e2eContract
    .replace('- terminal-attach','- `terminal-attach.spec.ts` — existing regression')
    .replace('| terminal-attach | Regression | Pending | - |',
      '| terminal-attach.spec.ts | Regression | Pending | not run |');
  assert.ok(parseIssueE2E(malformedE2e).errors.length>0);
  assert.deepEqual(parseIssueE2E(e2eContract).errors,[]);
  enforceE2EReadOnly(malformedE2e,e2eContract);
  assert.throws(()=>enforceE2EReadOnly(malformedE2e,malformedE2e),/Unauthorized E2E/);
  assert.throws(()=>enforceE2EReadOnly(malformedE2e,'no E2E sections'),/Unauthorized E2E/);
  assert.throws(()=>enforceE2EReadOnly(malformedE2e,
    e2eContract.replace('| Pending | - |','| Pending | not run |')),/Unauthorized E2E/);
  const badPending=e2eContract.replace('| Pending | - |','| Pending | not run |');
  enforceE2EReadOnly(badPending,e2eContract);
  assert.throws(()=>enforceE2EReadOnly(badPending,e2eContract
    .replace('- terminal-attach','- terminal-replay')
    .replace('| terminal-attach | Regression','| terminal-replay | Regression')),/Unauthorized E2E/);

  // Already-authenticated results must survive any repair of a different bad
  // Pending row, and an Agent cannot mint a new completed result as a side
  // effect of normalizing a malformed Report.
  const twoIds=e2eContract.replace('- terminal-attach','- terminal-attach\n- terminal-replay')
    .replace('| terminal-attach | Regression | Pending | - |',
      '| terminal-attach | Regression | Pending | - |\n| terminal-replay | Regression | Pending | - |');
  const digest=parseIssueE2E(twoIds).digest;
  const receipt='run 1/1, SHA '+ 'a'.repeat(40)+', contract '+digest+
    ', plan '+ 'b'.repeat(64)+', tests 1/1 (https://github.com/BestNathan/nession/actions/runs/1)';
  const completed=twoIds.replace('| terminal-attach | Regression | Pending | - |',
    '| terminal-attach | Regression | Pass | '+receipt+' |');
  assert.deepEqual(parseIssueE2E(completed).errors,[]);
  const malformedWithReceipt=completed.replace('| terminal-replay | Regression | Pending | - |',
    '| terminal-replay | Regression | Pending | not run |');
  enforceE2EReadOnly(malformedWithReceipt,completed);
  assert.throws(()=>enforceE2EReadOnly(malformedWithReceipt,completed.replace(
    '| terminal-attach | Regression | Pass | '+receipt+' |',
    '| terminal-attach | Regression | Pending | - |')),/Unauthorized E2E/);
  assert.throws(()=>enforceE2EReadOnly(malformedWithReceipt,completed.replace(
    '| terminal-replay | Regression | Pending | - |',
    '| terminal-replay | Regression | Pass | '+receipt+' |')),/Unauthorized E2E/);

  // Exercise the exact Qwen-style body proposal via the fixed-target trusted
  // updater, including no-write rejection and revalidated persisted readback.
  const preE2eIssue=JSON.parse(readFileSync(filename,'utf8'));
  writeFileSync(filename,JSON.stringify({
    ...preE2eIssue,body:preE2eIssue.body+'\n\n'+malformedE2e,
  }));
  const malformedSnapshot=readFileSync(filename,'utf8');
  await assert.rejects(applyIssueAuditProposal(issue,{
    result:JSON.stringify({body:preE2eIssue.body+'\n\n'+badPending}),
  },'example/repo'),/Unauthorized E2E/);
  assert.equal(readFileSync(filename,'utf8'),malformedSnapshot,
    'invalid proposed E2E repairs must not write the Issue');
  await applyIssueAuditProposal(issue,{
    result:JSON.stringify({body:preE2eIssue.body+'\n\n'+e2eContract}),
  },'example/repo');
  const repairedE2e=JSON.parse(readFileSync(filename,'utf8'));
  assert.ok(repairedE2e.body.endsWith(e2eContract));
  assert.deepEqual(parseIssueE2E(repairedE2e.body).errors,[]);
  writeFileSync(filename,JSON.stringify(preE2eIssue));
  console.log('gh issue tools self-test: malformed E2E repair and immutable evidence passed');
} finally {
  process.env.PATH = oldPath;
  if (oldFile == null) delete process.env.FAKE_GH_ISSUE_FILE;
  else process.env.FAKE_GH_ISSUE_FILE = oldFile;
  rmSync(tmp, { recursive: true, force: true });
}