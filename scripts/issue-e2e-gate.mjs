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
function selfTest(){
  const sha='a'.repeat(40);
  const prefix=['## E2E Verification','### New','- none: no new test',
    '### Regression','- terminal-attach','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|'];
  const body0=prefix.concat(['| terminal-attach | Regression | Pending | - |']).join('\n');
  const decl=parseIssueE2E(body0);
  const pass=body0.replace('| Pending | - |','| Pass | run 1/1, SHA '+sha+', contract '+decl.digest+', plan '+'b'.repeat(64)+', tests 1/1 |');
  assert.equal(verifyIssueE2EGate({body:pass},sha).ok,true);
  assert.equal(verifyIssueE2EGate({body:body0},sha).ok,false);
  assert.equal(verifyIssueE2EGate({body:pass},'b'.repeat(40)).ok,false);
  assert.equal(verifyIssueE2EGate({body:pass.replace('contract '+decl.digest, 'contract '+'0'.repeat(64))},sha).ok,false);
  const none=['## E2E Verification','### New','- none: no new tests',
    '### Regression','- none: no affected E2E','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|'].join('\n');
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
