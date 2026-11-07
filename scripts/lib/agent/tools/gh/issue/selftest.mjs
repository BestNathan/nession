import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIssueUpdateTool, enforceE2EReadOnly, completeIssueUpdateProposal } from './update.mjs';
import { applyIssueAuditProposal, applyIssueAuditWithContractRetry, renderIssueAuditContractRepairPrompt, isIssueAuditRepairableRejection } from '../../../tasks/issue-audit.mjs';
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
  "  if (args.includes('--title')) issue.title = field('--title');",
  "  if (args.includes('--body-file')) issue.body = fs.readFileSync(0, 'utf8');",
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

  // #2915: missing_area/kind_count are typed, pre-write proposal rejections.
  writeFileSync(filename,absentLabelSnapshot);
  let labelRepairCalls=0;
  const labelRepair=await applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({labels:['bug']}),
  },'example/repo',{
    contractRepair:async(previous,error)=>{
      labelRepairCalls++;
      assert.equal(error.code,'ISSUE_AUDIT_LABEL_CONTRACT');
      assert.match(error.message,/missing_area/);
      assert.equal(readFileSync(filename,'utf8'),absentLabelSnapshot);
      const prompt=renderIssueAuditContractRepairPrompt(unlabelled,previous.result,error.message);
      assert.match(prompt,/For a Bug or Requirement with missing or invalid kind\/area labels/);
      return {result:JSON.stringify({labels:['bug','web']})};
    },
  });
  assert.equal(labelRepairCalls,1);
  assert.equal(labelRepair.contract_repair_attempted,true);
  assert.deepEqual(JSON.parse(readFileSync(filename,'utf8')).labels.map(x=>x.name).sort(),
    ['bug','web']);

  // A second invalid draft is terminal; no Issue or model comment is written.
  writeFileSync(filename,absentLabelSnapshot);
  let exhaustedLabelCalls=0;
  await assert.rejects(applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({labels:['bug','ci','ci'],comment:'must not publish'}),
  },'example/repo',{
    contractRepair:async()=>{
      exhaustedLabelCalls++;
      assert.equal(readFileSync(filename,'utf8'),absentLabelSnapshot);
      return {result:JSON.stringify({labels:['bug'],comment:'must not publish'})};
    },
  }),/missing_area/);
  assert.equal(exhaustedLabelCalls,1);
  assert.equal(readFileSync(filename,'utf8'),absentLabelSnapshot);
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
  const previousComment=readFileSync(filename+'.comment','utf8');
  await assert.rejects(applyIssueAuditProposal(issue,{
    result:JSON.stringify({comment:'invalid source must not be annotated as audited'}),
  },'example/repo'),/left the invalid Issue Contract unrepaired/);
  assert.equal(readFileSync(filename,'utf8'),malformedSnapshot);
  assert.equal(readFileSync(filename+'.comment','utf8'),previousComment);
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

  // #2921 / live #2878: - none: is a DECLARATION, never a Report row ID.
  const emptyNone=[
    '## E2E Verification','### New','- none: focused browser Case not yet selected',
    '### Regression','- none: existing test does not prove the ordering',
    '## E2E Report','| ID | Type | Result | Evidence |','|---|---|---|---|',
  ].join('\n');
  const invalidNone=emptyNone+
    '\n| none | New | Pending | Focused browser Case not yet selected |'+
    '\n| none | Regression | Pending | Existing test not yet established |';
  assert.deepEqual(parseIssueE2E(emptyNone).errors,[]);
  assert.ok(parseIssueE2E(invalidNone).errors.some(e=>e.includes('unrequired E2E Report ID')));
  const noneTarget={...preE2eIssue,body:preE2eIssue.body+'\n\n'+invalidNone};
  writeFileSync(filename,JSON.stringify(noneTarget));
  const noneSnapshot=readFileSync(filename,'utf8');
  let noneRepairCalls=0;
  const noneRepair=await applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({body:noneTarget.body}),
  },'example/repo',{
    contractRepair:async(previous,error)=>{
      noneRepairCalls++;
      assert.equal(error.code,'ISSUE_AUDIT_E2E_PROTECTED');
      assert.match(error.message,/none placeholders are not selected IDs/);
      assert.equal(readFileSync(filename,'utf8'),noneSnapshot);
      const prompt=renderIssueAuditContractRepairPrompt(noneTarget,previous.result,error.message);
      assert.match(prompt,/E2E Report MUST contain ONLY the table/);
      return {result:JSON.stringify({body:preE2eIssue.body+'\n\n'+emptyNone})};
    },
  });
  assert.equal(noneRepairCalls,1);
  assert.equal(noneRepair.contract_repair_attempted,true);
  const afterNone=JSON.parse(readFileSync(filename,'utf8'));
  assert.equal(afterNone.body,preE2eIssue.body+'\n\n'+emptyNone);
  assert.deepEqual(parseIssueE2E(afterNone.body).selectedIds,[]);
  assert.deepEqual(parseIssueE2E(afterNone.body).errors,[]);

  // A second malformed Report still fails closed, leaving the target intact.
  writeFileSync(filename,noneSnapshot);
  let noneFailedCalls=0;
  await assert.rejects(applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({body:noneTarget.body}),
  },'example/repo',{
    contractRepair:async()=>{
      noneFailedCalls++;
      return {result:JSON.stringify({body:noneTarget.body})};
    },
  }),/Unauthorized E2E/);
  assert.equal(noneFailedCalls,1);
  assert.equal(readFileSync(filename,'utf8'),noneSnapshot);
  writeFileSync(filename,JSON.stringify(preE2eIssue));
  // Live #42216764125: the original may have both malformed E2E and
  // Knowledge Impact. A Qwen first pass fixing only E2E must NOT be written.
  // One bounded continuation receives the canonical validation findings.
  const malformedKnowledge=[
    '### Knowledge Impact',
    '- **Decision:** Update.',
    '- **Related knowledge:** docs/architecture/acceptance-sc-format.md',
    '- **Reason:** clarify the Issue Audit validation and model repair boundary',
    '- **Owner and timing:** Agent infrastructure owner before merge',
    '- **Evidence:** deterministic Issue Audit regression at exact PR SHA',
  ].join('\n');
  const originalWithTwoDefects={
    ...preE2eIssue,
    createdAt:'2026-11-06T12:00:00Z',
    body:preE2eIssue.body+'\n\n'+malformedKnowledge+'\n\n'+malformedE2e,
  };
  const firstDraft=preE2eIssue.body+'\n\n'+malformedKnowledge+'\n\n'+e2eContract;
  const repairedKnowledge=[
    '### Knowledge Impact',
    '- Decision: Update',
    '- Related knowledge: docs/architecture/acceptance-sc-format.md',
    '- Reason: clarify the Issue Audit validation and model repair boundary',
    '- Owner and timing: Agent infrastructure owner before merge',
    '- Evidence: deterministic Issue Audit regression at exact PR SHA',
  ].join('\n');
  const secondDraft=firstDraft.replace(malformedKnowledge,repairedKnowledge);
  writeFileSync(filename,JSON.stringify(originalWithTwoDefects));
  const originalSnapshot=readFileSync(filename,'utf8');
  let contractCalls=0;
  const outcome=await applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({body:firstDraft}),
  },'example/repo',{
    contractRepair:async(previous,error)=>{
      contractCalls++;
      assert.match(error.message,/Knowledge Impact missing decision/);
      assert.equal(readFileSync(filename,'utf8'),originalSnapshot,
        'first rejected draft must NEVER partially write');
      const prompt=renderIssueAuditContractRepairPrompt(
        originalWithTwoDefects,previous.result,error.message);
      assert.match(prompt,/Knowledge Impact MUST use five literal bullet keys/);
      assert.match(prompt,/Knowledge Impact missing decision/);
      assert.match(prompt,/no tools/);
      return {result:JSON.stringify({body:secondDraft})};
    },
  });
  assert.equal(contractCalls,1);
  assert.equal(outcome.contract_repair_attempted,true);
  const twoFixed=JSON.parse(readFileSync(filename,'utf8'));
  assert.equal(twoFixed.body,secondDraft);
  assert.deepEqual(parseIssueE2E(twoFixed.body).errors,[]);

  // A second invalid draft fails closed after exactly one retry; no writes.
  writeFileSync(filename,originalSnapshot);
  let rejectedCalls=0;
  await assert.rejects(applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({body:firstDraft}),
  },'example/repo',{
    contractRepair:async()=>{rejectedCalls++;return {result:JSON.stringify({body:firstDraft})};},
  }),/Knowledge Impact missing decision/);
  assert.equal(rejectedCalls,1);
  assert.equal(readFileSync(filename,'utf8'),originalSnapshot);

  // #2915: an E2E-scope change is rejected pre-write. A single
  // non-mutating correction can succeed only when valid E2E stays verbatim.
  writeFileSync(filename,JSON.stringify({...preE2eIssue,body:preE2eIssue.body+'\n\n'+e2eContract}));
  const validSnapshot=readFileSync(filename,'utf8');
  const originalValid=JSON.parse(validSnapshot);
  const changedE2e=originalValid.body
    .replace('- terminal-attach','- terminal-replay')
    .replace('| terminal-attach | Regression','| terminal-replay | Regression');
  let protectedRepairCalls=0;
  const protectedRepair=await applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({body:changedE2e}),
  },'example/repo',{
    contractRepair:async(previous,error)=>{
      protectedRepairCalls++;
      assert.equal(error.code,'ISSUE_AUDIT_E2E_PROTECTED');
      assert.equal(readFileSync(filename,'utf8'),validSnapshot);
      const prompt=renderIssueAuditContractRepairPrompt(originalValid,previous.result,error.message);
      assert.match(prompt,/copy BOTH sections VERBATIM/);
      return {result:JSON.stringify({
        title:'Requirement: safe structural repair',body:originalValid.body,
      })};
    },
  });
  assert.equal(protectedRepairCalls,1);
  assert.equal(protectedRepair.contract_repair_attempted,true);
  const corrected=JSON.parse(readFileSync(filename,'utf8'));
  assert.equal(corrected.title,'Requirement: safe structural repair');
  assert.equal(corrected.body,originalValid.body);
  assert.deepEqual(parseIssueE2E(corrected.body).errors,[]);

  // A second unsafe proposal, including forged evidence, fails closed.
  writeFileSync(filename,validSnapshot);
  let unsafeCalls=0;
  await assert.rejects(applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({body:changedE2e}),
  },'example/repo',{
    contractRepair:async()=>{
      unsafeCalls++;
      return {result:JSON.stringify({body:originalValid.body
        .replace('| Pending | - |','| Pass | forged |')})};
    },
  }),/Unauthorized E2E/);
  assert.equal(unsafeCalls,1);
  assert.equal(readFileSync(filename,'utf8'),validSnapshot);

  // Error text alone cannot authorize a retry. Real permission, provider,
  // post-write and verification-tier failures never get an extra model call.
  for(const failure of [
    new Error('Issue labels must be distinct canonical kind/area labels (missing_area)'),
    new Error('Unauthorized E2E Verification / Report mutation by Issue Agent'),
    new Error('GitHub API error 403: permission denied'),
    new Error('Provider HTTP 429'),
    new Error('Issue was written but post-write contract failed'),
    new Error('verification-tier downgrade requires separate trusted approval'),
  ])assert.equal(isIssueAuditRepairableRejection(failure),false,failure.message);
  let unauthorizedCalls=0;
  await assert.rejects(applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({issue_number:999,body:originalValid.body}),
  },'example/repo',{
    contractRepair:async()=>{unauthorizedCalls++;return {result:'{}'};},
  }),/unauthorized fields/);
  assert.equal(unauthorizedCalls,0);
  assert.equal(readFileSync(filename,'utf8'),validSnapshot);
  writeFileSync(filename,JSON.stringify(preE2eIssue));

  // #2919: Qwen may return a missing or too-short verification_tier reason.
  // The first draft cannot mutate anything, and only one corrected, trusted
  // tier tool invocation may add the optional verification label.
  const preTierSnapshot=readFileSync(filename,'utf8');
  let tierRepairCalls=0;
  const tierRepair=await applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({verification_tier:'verification:scoped',tier_reason:'short'}),
  },'example/repo',{
    contractRepair:async(previous,error)=>{
      tierRepairCalls++;
      assert.equal(error.code,'ISSUE_AUDIT_TIER_PROPOSAL');
      assert.match(error.message,/invalid Issue verification-tier proposal/);
      assert.equal(readFileSync(filename,'utf8'),preTierSnapshot,
        'rejected tier proposal must not change Issue title/body/labels');
      const prompt=renderIssueAuditContractRepairPrompt(preE2eIssue,previous.result,error.message);
      assert.match(prompt,/tier_reason MUST also be present/);
      return {result:JSON.stringify({
        verification_tier:'verification:scoped',
        tier_reason:'Scoped deterministic issue audit contract and negative regression fixture.',
      })};
    },
  });
  assert.equal(tierRepairCalls,1);
  assert.equal(tierRepair.contract_repair_attempted,true);
  const afterTier=JSON.parse(readFileSync(filename,'utf8'));
  const beforeTier=JSON.parse(preTierSnapshot);
  assert.equal(afterTier.title,beforeTier.title);
  assert.equal(afterTier.body,beforeTier.body);
  assert.deepEqual(afterTier.labels.map(x=>x.name).sort(),
    [...beforeTier.labels.map(x=>x.name),'verification:scoped'].sort());

  // The second invalid reason is terminal and does not publish any labels.
  writeFileSync(filename,preTierSnapshot);
  let exhaustedTierCalls=0;
  await assert.rejects(applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({verification_tier:'verification:scoped'}),
  },'example/repo',{
    contractRepair:async()=>{
      exhaustedTierCalls++;
      return {result:JSON.stringify({verification_tier:'verification:scoped',tier_reason:'still short'})};
    },
  }),/invalid Issue verification-tier proposal/);
  assert.equal(exhaustedTierCalls,1);
  assert.equal(readFileSync(filename,'utf8'),preTierSnapshot);

  // Tier downgrade is an authorization denial, not a format-repair hint.
  const downgradeTarget={...beforeTier,labels:[
    ...beforeTier.labels,{name:'verification:full'}]};
  writeFileSync(filename,JSON.stringify(downgradeTarget));
  const downgradeSnapshot=readFileSync(filename,'utf8');
  let downgradeCalls=0;
  await assert.rejects(applyIssueAuditWithContractRetry(issue,{
    result:JSON.stringify({
      verification_tier:'verification:scoped',
      tier_reason:'This is a sufficiently long but forbidden downgrade justification.',
    }),
  },'example/repo',{
    contractRepair:async()=>{downgradeCalls++;return {result:'{}'};},
  }),/downgrade requires separate trusted approval/);
  assert.equal(downgradeCalls,0);
  assert.equal(readFileSync(filename,'utf8'),downgradeSnapshot);
  writeFileSync(filename,preTierSnapshot);

  // Reject illegal risk or comment metadata before any body mutation.
  const tierLocked={...preE2eIssue,
    labels:[...preE2eIssue.labels,{name:'verification:full'}]};
  writeFileSync(filename,JSON.stringify(tierLocked));
  const lockedSnapshot=readFileSync(filename,'utf8');
  const validTierReason='Risk assessed for this bounded audit; no downgrade is authorized.';
  for(const proposal of [
    {title:'Requirement: rejected tier reason',verification_tier:'verification:integration',tier_reason:'too short'},
    {title:'Requirement: rejected downgrade',verification_tier:'verification:scoped',tier_reason:validTierReason},
    {title:'Requirement: rejected comment',comment:'x'.repeat(8001)},
  ]){
    await assert.rejects(applyIssueAuditProposal(issue,{
      result:JSON.stringify(proposal),
    },'example/repo'),/invalid Issue verification-tier proposal|downgrade|invalid Issue Audit comment/);
    assert.equal(readFileSync(filename,'utf8'),lockedSnapshot,
      'invalid metadata cannot partially update the Issue');
  }
  writeFileSync(filename,JSON.stringify(preE2eIssue));

  console.log('gh issue tools self-test: malformed E2E repair and immutable evidence passed');
} finally {
  process.env.PATH = oldPath;
  if (oldFile == null) delete process.env.FAKE_GH_ISSUE_FILE;
  else process.env.FAKE_GH_ISSUE_FILE = oldFile;
  rmSync(tmp, { recursive: true, force: true });
}