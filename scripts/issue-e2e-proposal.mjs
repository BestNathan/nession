#!/usr/bin/env node
// Agent E2E suggestions are untrusted Issue discussion, not acceptance evidence.
// Only an approved, source-bound trusted caller may apply additive obligations.
import assert from 'node:assert/strict';
import { parseIssueE2E, verifyIssueE2EAgainstCatalog } from './issue-e2e-contract.mjs';
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLES = new Set(['Developer','Reviewer']);

export function proposeIssueE2E({issue, role, newIds=[], regressionIds=[], reason, contractDigest}) {
  if(!Number.isSafeInteger(issue)||issue<=0||!ROLES.has(role))throw Error('invalid proposal author/target');
  if(typeof reason!=='string'||reason.trim().length<12||reason.length>1000)throw Error('concrete proposal reason required');
  if(!Array.isArray(newIds)||!Array.isArray(regressionIds)||!newIds.length&&!regressionIds.length)
    throw Error('proposal must add at least one E2E ID');
  const chosen=[...newIds,...regressionIds];
  if(chosen.some(id=>typeof id!=='string'||!ID.test(id))||new Set(chosen).size!==chosen.length)
    throw Error('duplicate or invalid proposed test ID');
  if(!/^[0-9a-f]{64}$/.test(contractDigest))throw Error('proposal requires current Issue digest');
  return {schema_version:1,kind:'issue_e2e_proposal',issue,role,
    new_ids:[...newIds].sort(),regression_ids:[...regressionIds].sort(),
    contract_digest:contractDigest,reason:reason.trim()};
}
export function proposalComment(proposal) {
  const item=proposeIssueE2E({issue:proposal.issue,role:proposal.role,
    newIds:proposal.new_ids,regressionIds:proposal.regression_ids,
    reason:proposal.reason,contractDigest:proposal.contract_digest});
  return ['## E2E Impact Proposal (Agent — untrusted)',
    'Issue: #'+item.issue,'Role: '+item.role,'Based-on contract: '+item.contract_digest,
    'New: '+(item.new_ids.join(', ')||'none'),
    'Regression: '+(item.regression_ids.join(', ')||'none'),
    'Reason: '+item.reason,'Review status: Awaiting trusted approval',
    'This comment does not alter required tests or E2E Report.'].join('\n');
}
function appendIds(body,heading,ids) {
  if(!ids.length)return body;
  const lines=body.replace(/\r\n?/g,'\n').split('\n');
  const h=lines.findIndex(line=>line.trim()==='### '+heading);
  if(h<0)throw Error('missing '+heading+' section');
  let end=lines.findIndex((line,i)=>i>h&&/^(##|###)\s/.test(line));
  if(end<0)throw Error('unterminated '+heading+' section');
  const slice=lines.slice(h+1,end).filter(line=>!/^\s*- none:/.test(line));
  lines.splice(h+1,end-h-1,...slice.filter(line=>line.trim()!==''),...ids.map(id=>'- '+id),'');
  return lines.join('\n');
}
export function applyApprovedE2EProposal({issue,proposal,approval,headIds,baseIds}) {
  if(!issue||issue.number!==proposal?.issue||!approval||approval.source!=='trusted-reviewer'||
      approval.approved!==true||approval.issue!==issue.number||
      approval.contract_digest!==proposal.contract_digest)throw Error('trusted approval required');
  const existing=parseIssueE2E(issue.body,{requireDeclaration:true});
  if(existing.errors.length||existing.digest!==proposal.contract_digest)
    throw Error('Issue E2E contract changed since Agent proposal');
  const item=proposeIssueE2E({issue:proposal.issue,role:proposal.role,
    newIds:proposal.new_ids,regressionIds:proposal.regression_ids,
    reason:proposal.reason,contractDigest:proposal.contract_digest});
  const existingIDs=new Set(existing.selectedIds);
  for(const id of [...item.new_ids,...item.regression_ids])
    if(existingIDs.has(id))throw Error('proposed E2E ID already declared: '+id);
  let body=appendIds(issue.body,'New',item.new_ids);
  body=appendIds(body,'Regression',item.regression_ids);
  const lines=body.split('\n');
  const start=lines.findIndex(line=>line.trim()==='## E2E Report');
  const end=lines.findIndex((line,i)=>i>start&&/^##\s/.test(line));
  if(start<0)throw Error('E2E Report absent');
  const insertAt=end<0?lines.length:end;
  const rows=[...item.new_ids.map(id=>'| '+id+' | New | Pending | - |'),
    ...item.regression_ids.map(id=>'| '+id+' | Regression | Pending | - |')];
  lines.splice(insertAt,0,...rows);
  const updated=lines.join('\n');
  const verified=parseIssueE2E(updated,{requireDeclaration:true});
  if(verified.errors.length)throw Error('trusted E2E update invalid: '+verified.errors.join('; '));
  verifyIssueE2EAgainstCatalog(verified,headIds,baseIds);
  return {body:updated,contract_digest:verified.digest,selected_ids:verified.selectedIds};
}

function selfTest() {
  const initial=['## E2E Verification','### New','- none: no new tests',
    '### Regression','- none: no existing tests affected','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|',
    '## Acceptance Report','| Criterion | Result | Evidence |','|---|---|---|'].join('\n');
  const issue={number:44,body:initial};
  const before=parseIssueE2E(initial);
  const proposal=proposeIssueE2E({issue:44,role:'Reviewer',
    newIds:['terminal-resume'],regressionIds:['terminal-attach'],
    reason:'Terminal resume changes the existing attach recovery behavior.',
    contractDigest:before.digest});
  const approval={source:'trusted-reviewer',approved:true,issue:44,contract_digest:before.digest};
  assert.match(proposalComment(proposal),/Awaiting trusted approval/);
  const after=applyApprovedE2EProposal({issue,proposal,approval,
    headIds:['terminal-resume','terminal-attach'],baseIds:['terminal-attach']});
  assert.deepEqual(after.selected_ids,['terminal-attach','terminal-resume']);
  assert.equal(parseIssueE2E(after.body).rows.get('terminal-resume').result,'Pending');
  assert.match(after.body,/## Acceptance Report/);
  assert.notEqual(after.contract_digest,before.digest);
  assert.throws(()=>applyApprovedE2EProposal({issue,proposal,approval:{...approval,approved:false},
    headIds:['terminal-resume','terminal-attach'],baseIds:['terminal-attach']}),/approval/);
  assert.throws(()=>applyApprovedE2EProposal({issue:{...issue,body:after.body},proposal,approval,
    headIds:['terminal-resume','terminal-attach'],baseIds:['terminal-attach']}),/changed/);
  assert.throws(()=>applyApprovedE2EProposal({issue,proposal,approval,
    headIds:['terminal-attach'],baseIds:['terminal-attach']}),/New E2E/);
  assert.throws(()=>proposeIssueE2E({...proposal,newIds:['duplicate'],regressionIds:['duplicate'],
    contractDigest:before.digest}),/duplicate/);
  console.log('E2E Agent proposal: typed suggestion, trusted additive update, stale and unauthorized negatives passed');
}
if(process.argv[2]==='self-test')selfTest();
