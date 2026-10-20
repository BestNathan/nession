#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// E2E Issue gate: Issue-declared tests must all have evidence on the exact PR SHA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIssueE2E } from './issue-e2e-contract.mjs';

const SHA=/^[a-f0-9]{40}$/;
export function verifyIssueE2EGate(issue,targetSha) {
  if(!SHA.test(targetSha))throw Error('exact target SHA required');
  const decl=parseIssueE2E(issue.body,{requireDeclaration:true});
  if(decl.errors.length)throw Error('invalid E2E declaration: '+decl.errors.join('; '));
  const failures=[];
  for(const id of decl.selectedIds){
    const row=decl.rows.get(id);
    if(!row || row.result!=='Pass') {failures.push(id+': not Pass');continue;}
    if(!row.evidence.includes('SHA '+targetSha+',') ||
       !row.evidence.includes('contract '+decl.digest+',') ||
       !/\bplan [0-9a-f]{64},/.test(row.evidence)){
      failures.push(id+': stale or unbound evidence');
    }
  }
  return {ok:failures.length===0,required:decl.selectedIds.length,failures,
    reason:decl.selectedIds.length?'selected':'explicit-none'};
}
// Guard the privileged wake router against falsely requiring a plan receipt
// on a validated no-E2E Issue. Only selected Issues can authorize a rerun.
export function assertTrustedWakeRouting(workflow) {
  const begin=workflow.indexOf('name: Authenticate E2E result and reconcile exact-head Acceptance run');
  const end=workflow.indexOf('  # Source Quality/E2E workflow_run completion',begin);
  if(begin<0||end<begin)throw Error('missing canonical event-driven E2E wake');
  const part=workflow.slice(begin,end);
  if(!part.includes('node scripts/issue-e2e-gate.mjs verify-json')||
     !part.includes('case "$(jq -r .reason <<< "$verdict")" in')||
     !/selected\)[\s\S]*?\.body \| contains\("plan " \+ \$digest \+ ","\)/.test(part)||
     !/explicit-none\)[\s\S]*?\.required/.test(part)||
     !part.includes('(( verified > 0 ))'))
    throw Error('E2E wake must require exact Plan only for selected and never for explicit-none');
  const selected=part.slice(part.indexOf('                selected)'),part.indexOf('                explicit-none)'));
  const none=part.slice(part.indexOf('                explicit-none)'),part.indexOf('                *) echo'));
  if(!selected.includes('verified=$((verified + 1))')||
     none.includes('verified=$((verified + 1))')||
     none.includes('plan " + $digest'))
    throw Error('empty-E2E wake must not grant selected evidence authority');
}
function selfTest(){
  const sha='a'.repeat(40);
  const prefix=['## E2E Verification','### New','- none: no new test',
    '### Regression','- terminal-attach','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|'];
  const body0=prefix.concat(['| terminal-attach | Regression | Pending | - |']).join('\n');
  const decl=parseIssueE2E(body0);
  const pass=body0.replace('| Pending | - |','| Pass | run 1/1, SHA '+sha+', contract '+decl.digest+', plan '+'b'.repeat(64)+', tests 1/1 (https://github.com/BestNathan/nession/actions/runs/1) |');
  assert.equal(verifyIssueE2EGate({body:pass},sha).ok,true);
  assert.equal(verifyIssueE2EGate({body:body0},sha).ok,false);
  assert.equal(verifyIssueE2EGate({body:pass},'b'.repeat(40)).ok,false);
  assert.throws(()=>verifyIssueE2EGate({body:pass.replace('contract '+decl.digest, 'contract '+'0'.repeat(64))},sha),/invalid E2E declaration/);
  const none=['## E2E Verification','### New','- none: no new tests',
    '### Regression','- none: no affected E2E','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|'].join('\n');
  const trustedWorkflow=fs.readFileSync('.github/workflows/acceptance-orchestrator.yml','utf8');
  assert.doesNotThrow(()=>assertTrustedWakeRouting(trustedWorkflow));
  assert.throws(()=>assertTrustedWakeRouting(trustedWorkflow.replace(
    'node scripts/issue-e2e-gate.mjs verify-json',
    'node scripts/issue-e2e-gate.mjs verify')),
    /E2E wake must/);
  assert.throws(()=>assertTrustedWakeRouting(trustedWorkflow.replace(
    'verified=$((verified + 1))\n                  ;;\n                explicit-none)',
    'verified=$((verified + 1))\n                  ;;\n                explicit-none)\n                  verified=$((verified + 1))')),
    /empty-E2E wake/);
  assert.equal(verifyIssueE2EGate({body:none},sha).reason,'explicit-none');
  assert.equal(verifyIssueE2EGate({body:none},sha).required,0);
  assert.equal(verifyIssueE2EGate({body:pass},sha).required,1);
  assert.equal(verifyIssueE2EGate({body:pass.replace('Pass','Fail')},sha).ok,false);
  assert.throws(()=>verifyIssueE2EGate({body:none.replace('### Regression','### Regress')},sha),/invalid E2E declaration/);
  console.log('Issue E2E Gate: correct SHA/digest Pass, missing, stale and explicit-none fixtures passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const [cmd,issueFile,sha]=process.argv.slice(2);
if(cmd==='self-test')selfTest();
else if(cmd==='verify'||cmd==='verify-json'){
  const issue=JSON.parse(fs.readFileSync(issueFile,'utf8'));
  const result=verifyIssueE2EGate(issue,sha);
  if(!result.ok)throw Error(result.failures.join('; '));
  if(cmd==='verify-json')
    console.log(JSON.stringify({reason:result.reason,required:result.required}));
  else console.log('Issue E2E Gate: '+result.reason+', '+result.required+' required IDs passed');
}else throw Error('self-test | verify ISSUE_JSON SHA | verify-json ISSUE_JSON SHA');
}
