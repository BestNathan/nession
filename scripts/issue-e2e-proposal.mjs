#!/usr/bin/env node
// Agent E2E suggestions are untrusted Issue discussion, not acceptance evidence.
// Only an approved, source-bound trusted caller may apply additive obligations.
import assert from 'node:assert/strict';
import {
  formatE2EEvidence, parseE2EEvidence, parseIssueE2E, verifyIssueE2EAgainstCatalog,
} from './issue-e2e-contract.mjs';
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLES = new Set(['Developer','Reviewer']);
const ARCHIVE_HEADING = '## E2E Receipt Archive';
const ARCHIVE_COLUMNS = '| ID | Type | Result | Contract | Evidence |';
const ARCHIVE_SEPARATOR = '|---|---|---|---|---|';

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
function reportSection(lines) {
  const start=lines.findIndex(line=>line.trim()==='## E2E Report');
  if(start<0)throw Error('E2E Report absent');
  const end=lines.findIndex((line,i)=>i>start&&/^##\s/.test(line));
  return {start,end:end<0?lines.length:end};
}
function receiptContract(evidence) {
  const match=/, contract ([a-f0-9]{64}), plan /.exec(evidence);
  return match?match[1]:'';
}
/**
 * Retire active receipts before the declaration digest changes (#2563).
 *
 * A trusted amendment changes the New/Regression set, so the digest changes.
 * An existing Pass/Fail/Error row is authenticated against the OLD digest and
 * would make the amended body unparseable. Each active receipt is re-verified
 * against the retired digest, appended verbatim to the nonactive audit section
 * by the caller, and the current row is reset to Pending | -. Only receipts of
 * the current contract may live in ## E2E Report.
 */
function retireActiveReceipts(body,retiredDigest) {
  const lines=body.replace(/\r\n?/g,'\n').split('\n');
  const {start,end}=reportSection(lines);
  const retired=[];
  for(let i=start+1;i<end;i+=1){
    const line=lines[i];
    if(!line.trim().startsWith('|'))continue;
    const cells=line.split('|').slice(1,-1).map(cell=>cell.trim());
    if(cells.every(cell=>/^:?-{3,}:?$/.test(cell)))continue;
    if(cells[0].toLowerCase()==='id')continue;
    if(cells.length!==4)throw Error('invalid E2E Report row');
    const [id,type,result,evidence]=cells;
    if(result==='Pending')continue;
    // A row leaving the active contract must still be an authenticated
    // receipt of the digest being retired; a forged row is not archived.
    parseE2EEvidence({result,evidence},retiredDigest);
    retired.push({id,type,result,evidence,contract:receiptContract(evidence)});
    lines[i]='| '+id+' | '+type+' | Pending | - |';
  }
  return {lines,retired};
}
/** Append retired receipts to the append-only audit section; never rewrite it. */
function appendReceiptArchive(lines,retired) {
  if(!retired.length)return lines;
  const rows=retired.map(row=>'| '+row.id+' | '+row.type+' | '+row.result+
    ' | '+row.contract+' | '+row.evidence+' |');
  const heading=lines.findIndex(line=>line.trim()===ARCHIVE_HEADING);
  if(heading<0){
    while(lines.length&&lines[lines.length-1].trim()==='')lines.pop();
    lines.push('',ARCHIVE_HEADING,'',
      '<!-- append-only: receipts retired when a trusted amendment changed the E2E contract -->',
      '',ARCHIVE_COLUMNS,ARCHIVE_SEPARATOR,...rows,'');
    return lines;
  }
  let end=lines.findIndex((line,i)=>i>heading&&/^##\s/.test(line));
  if(end<0)end=lines.length;
  const header=lines.findIndex((line,i)=>i>heading&&i<end&&line.trim().startsWith('|'));
  if(header<0){
    lines.splice(end,0,'',ARCHIVE_COLUMNS,ARCHIVE_SEPARATOR,...rows);
    return lines;
  }
  let insertAt=header+1;
  for(let i=header;i<end;i+=1)if(lines[i].trim().startsWith('|'))insertAt=i+1;
  lines.splice(insertAt,0,...rows);
  return lines;
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
  // Retire before the digest changes: the rows and the archive stay one
  // in-memory transaction, so no partially-amended body can be observed.
  const retired=retireActiveReceipts(issue.body,existing.digest);
  let body=appendIds(retired.lines.join('\n'),'New',item.new_ids);
  body=appendIds(body,'Regression',item.regression_ids);
  const lines=body.split('\n');
  const start=lines.findIndex(line=>line.trim()==='## E2E Report');
  const end=lines.findIndex((line,i)=>i>start&&/^##\s/.test(line));
  if(start<0)throw Error('E2E Report absent');
  const insertAt=end<0?lines.length:end;
  const rows=[...item.new_ids.map(id=>'| '+id+' | New | Pending | - |'),
    ...item.regression_ids.map(id=>'| '+id+' | Regression | Pending | - |')];
  lines.splice(insertAt,0,...rows);
  const updated=appendReceiptArchive(lines,retired.retired).join('\n');
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

  // #2563: a trusted amendment retires active receipts atomically. Each
  // terminal result shape is accepted, re-authenticated against the digest
  // being retired, archived, and reset in the current report.
  const historyBody=(rows)=>['## E2E Verification','### New','- none: no new tests',
    '### Regression','- terminal-attach','## E2E Report',
    '| ID | Type | Result | Evidence |','|---|---|---|---|',...rows,
    '## Acceptance Report','| Criterion | Result | Evidence |','|---|---|---|'].join('\n');
  for(const [result,passed,discovered] of [['Pass',1,1],['Fail',0,1],['Error',0,1]]){
    const history=historyBody([]);
    const oldDigest=parseIssueE2E(history).digest;
    const receipt=formatE2EEvidence({run:7,attempt:2,sha:'a'.repeat(40),
      contract:oldDigest,plan:'b'.repeat(64),passed,discovered},result);
    const withReceipt=historyBody(['| terminal-attach | Regression | '+result+' | '+receipt+' |']);
    assert.deepEqual(parseIssueE2E(withReceipt).errors,[],result);
    const amendment=proposeIssueE2E({issue:44,role:'Reviewer',newIds:['terminal-resume'],
      reason:'Terminal resume changes the existing attach recovery behavior.',
      contractDigest:oldDigest});
    const applied=applyApprovedE2EProposal({issue:{number:44,body:withReceipt},
      proposal:amendment,approval:{...approval,contract_digest:oldDigest},
      headIds:['terminal-resume','terminal-attach'],baseIds:['terminal-attach']});
    const after=parseIssueE2E(applied.body);
    assert.deepEqual(after.errors,[],result);
    assert.equal(after.rows.get('terminal-attach').result,'Pending',result);
    assert.equal(after.rows.get('terminal-resume').result,'Pending',result);
    assert.equal(after.rows.size,2,result);
    assert.match(applied.body,/## E2E Receipt Archive/,result);
    assert.ok(applied.body.includes('| terminal-attach | Regression | '+result+
      ' | '+oldDigest+' | '+receipt+' |'),result);
    // A forged active receipt is rejected by the default parser and cannot be
    // used to trigger an amendment (the trusted write never sees a bad body).
    const forged=withReceipt.replace(receipt,
      receipt.replace('contract '+oldDigest,'contract '+'c'.repeat(64)));
    assert.match(parseIssueE2E(forged).errors.join(','),/unauthenticated/,result);
    assert.throws(()=>applyApprovedE2EProposal({issue:{number:44,body:forged},
      proposal:amendment,approval:{...approval,contract_digest:oldDigest},
      headIds:['terminal-resume','terminal-attach'],baseIds:['terminal-attach']}),/changed/,result);
  }

  // A second amendment appends to the audit section; it never rewrites the
  // first archived receipt or duplicates the section.
  const first=historyBody([]);
  const firstDigest=parseIssueE2E(first).digest;
  const firstReceipt=formatE2EEvidence({run:8,attempt:1,sha:'a'.repeat(40),
    contract:firstDigest,plan:'b'.repeat(64),passed:1,discovered:1},'Pass');
  const firstApplied=applyApprovedE2EProposal({
    issue:{number:44,body:historyBody(['| terminal-attach | Regression | Pass | '+firstReceipt+' |'])},
    proposal:proposeIssueE2E({issue:44,role:'Reviewer',newIds:['terminal-resume'],
      reason:'First amendment for the terminal resume behavior.',
      contractDigest:firstDigest}),
    approval:{...approval,contract_digest:firstDigest},
    headIds:['terminal-resume','terminal-attach'],baseIds:['terminal-attach']});
  const secondDigest=firstApplied.contract_digest;
  const secondReceipt=formatE2EEvidence({run:9,attempt:1,sha:'a'.repeat(40),
    contract:secondDigest,plan:'b'.repeat(64),passed:1,discovered:1},'Pass');
  const secondBody=firstApplied.body.replace('| terminal-resume | New | Pending | - |',
    '| terminal-resume | New | Pass | '+secondReceipt+' |');
  assert.deepEqual(parseIssueE2E(secondBody).errors,[]);
  const secondApplied=applyApprovedE2EProposal({issue:{number:44,body:secondBody},
    proposal:proposeIssueE2E({issue:44,role:'Reviewer',regressionIds:['terminal-attach-bootstrap'],
      reason:'Second amendment adds the bootstrap regression after resume.',
      contractDigest:secondDigest}),
    approval:{...approval,contract_digest:secondDigest},
    headIds:['terminal-resume','terminal-attach','terminal-attach-bootstrap'],
    baseIds:['terminal-attach','terminal-attach-bootstrap']});
  assert.equal((secondApplied.body.match(/## E2E Receipt Archive/g)||[]).length,1);
  assert.ok(secondApplied.body.includes('| terminal-attach | Regression | Pass | '+
    firstDigest+' | '+firstReceipt+' |'));
  assert.ok(secondApplied.body.includes('| terminal-resume | New | Pass | '+
    secondDigest+' | '+secondReceipt+' |'));
  const secondRows=parseIssueE2E(secondApplied.body).rows;
  assert.equal(secondRows.get('terminal-attach').result,'Pending');
  assert.equal(secondRows.get('terminal-resume').result,'Pending');
  assert.equal(secondRows.get('terminal-attach-bootstrap').result,'Pending');
  console.log('E2E Agent proposal: typed suggestion, trusted additive update, receipt retirement/archive, stale and unauthorized negatives passed');
}
if(process.argv[2]==='self-test')selfTest();
