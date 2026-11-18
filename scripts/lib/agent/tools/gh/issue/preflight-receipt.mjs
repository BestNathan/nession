// Bounded local telemetry for the read-only Issue Audit MCP validator.
// Never store source Issue data, model proposal content, secrets or tool inputs.
// These receipts are observational, not GitHub Issue/E2E authorization.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_CALLS=3,MAX_FILE_BYTES=8192;
const DIGEST=/^[0-9a-f]{64}$/,CODE=/^(VALID_CANDIDATE|ISSUE_AUDIT_[A-Z0-9_]{3,70})$/;

const positive=(n)=>Number.isSafeInteger(Number(n))&&Number(n)>0&&String(Number(n))===String(n);
export function proposalDigest(value){
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw Error('Invalid preflight candidate for digest');
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function preflightReceiptPath(issue,env=process.env) {
  const run=env.GITHUB_RUN_ID,attempt=env.GITHUB_RUN_ATTEMPT,temp=env.RUNNER_TEMP;
  if(!positive(issue)||!positive(run)||!positive(attempt)||
     typeof temp!=='string'||!path.isAbsolute(temp))return null;
  return path.join(temp,'nession-issue-audit-preflight-'+issue+'-'+run+'-'+attempt+'.jsonl');
}
export function recordPreflightCheck({issueNumber,proposal,verdict,sequence,env=process.env}){
  const file=preflightReceiptPath(issueNumber,env);
  if(!file||!Number.isSafeInteger(sequence)||sequence<1||sequence>MAX_CALLS||
     !verdict||typeof verdict.ok!=='boolean'||!CODE.test(verdict.code))
    throw Error('Invalid bounded Issue Audit preflight receipt');
  const entry={
    version:1,issue:issueNumber,
    run:Number(env.GITHUB_RUN_ID),attempt:Number(env.GITHUB_RUN_ATTEMPT),
    sequence,proposal_sha256:proposalDigest(proposal),
    ok:verdict.ok,code:verdict.code,
  };
  appendFileSync(file,JSON.stringify(entry)+'\n',{encoding:'utf8',flag:'a',mode:0o600});
  if(statSync(file).size>MAX_FILE_BYTES)throw Error('Oversized Issue Audit preflight receipt');
}
export function readPreflightChecks({issueNumber,finalProposal,env=process.env}){
  const empty={observed:false,calls:0,passed:0,final_candidate_checked:false,
    codes:[],evidence_kind:'local-readonly-mcp-proposal-checks'};
  const file=preflightReceiptPath(issueNumber,env);
  if(!file||!existsSync(file))return empty;
  const bytes=statSync(file).size;
  if(bytes<1||bytes>MAX_FILE_BYTES)
    throw Error('Invalid Issue Audit preflight receipt byte limit');
  const lines=readFileSync(file,'utf8').split('\n').filter(Boolean);
  if(lines.length>MAX_CALLS||!lines.length)
    throw Error('Invalid Issue Audit preflight receipt call count');
  const parsed=lines.map(x=>JSON.parse(x));
  let previous=0;
  for(const x of parsed){
    if(Object.keys(x).sort().join(',')!==
       ['version','issue','run','attempt','sequence','proposal_sha256','ok','code'].sort().join(',')||
       x.version!==1||x.issue!==issueNumber||
       x.run!==Number(env.GITHUB_RUN_ID)||x.attempt!==Number(env.GITHUB_RUN_ATTEMPT)||
       !Number.isSafeInteger(x.sequence)||x.sequence!==++previous||
       !DIGEST.test(x.proposal_sha256)||typeof x.ok!=='boolean'||!CODE.test(x.code)||
       (x.ok !== (x.code==='VALID_CANDIDATE')))
      throw Error('Unauthenticated or inconsistent Issue Audit preflight receipt');
  }
  const hash=finalProposal?proposalDigest(finalProposal):null;
  return {observed:true,calls:parsed.length,passed:parsed.filter(x=>x.ok).length,
    final_candidate_checked:!!hash&&parsed.some(x=>x.ok&&x.proposal_sha256===hash),
    codes:parsed.map(x=>x.code),
    evidence_kind:'local-readonly-mcp-proposal-checks'};
}
export function selfTestPreflightReceipts(){
  const dir=mkdtempSync(path.join(os.tmpdir(),'nession-audit-proof-'));
  try {
    const env={RUNNER_TEMP:dir,GITHUB_RUN_ID:'44248779690',GITHUB_RUN_ATTEMPT:'1'};
    const options={issueNumber:3855,env};
    const original={title:'Requirement: Runner',labels:['requirement','agent']};
    const corrected={...original,body:'## Requirements: Runner'};
    assert.deepEqual(readPreflightChecks({...options,finalProposal:original}).codes,[]);
    recordPreflightCheck({...options,sequence:1,proposal:original,
      verdict:{ok:false,code:'ISSUE_AUDIT_CONTRACT_REJECTED'}});
    recordPreflightCheck({...options,sequence:2,proposal:corrected,
      verdict:{ok:true,code:'VALID_CANDIDATE'}});
    const proof=readPreflightChecks({...options,finalProposal:corrected});
    assert.equal(proof.observed,true);assert.equal(proof.calls,2);
    assert.equal(proof.passed,1);assert.equal(proof.final_candidate_checked,true);
    assert.equal(readPreflightChecks({...options,finalProposal:original}).final_candidate_checked,false);
    assert.deepEqual(proof.codes,['ISSUE_AUDIT_CONTRACT_REJECTED','VALID_CANDIDATE']);
    assert.ok(!readFileSync(preflightReceiptPath(3855,env),'utf8')
      .includes('Requirement: Runner'));
    assert.equal(readPreflightChecks({issueNumber:3856,env,
      finalProposal:corrected}).observed,false,'other Issue cannot borrow a receipt');
    const file=preflightReceiptPath(3855,env),saved=readFileSync(file,'utf8');
    const malformed=saved.replace('"issue":3855','"issue":3856');
    writeFileSync(file,malformed);
    assert.throws(()=>readPreflightChecks({...options,finalProposal:corrected}),
      /Unauthenticated or inconsistent/);
    writeFileSync(file,saved);
    recordPreflightCheck({...options,sequence:3,proposal:corrected,
      verdict:{ok:true,code:'VALID_CANDIDATE'}});
    assert.equal(readPreflightChecks({...options,finalProposal:corrected}).calls,3);
    assert.throws(()=>recordPreflightCheck({...options,sequence:4,
      proposal:corrected,verdict:{ok:true,code:'VALID_CANDIDATE'}}),
      /Invalid bounded/);
  }finally{rmSync(dir,{recursive:true,force:true});}
  console.log('Issue Audit preflight local receipts: bounded, source-bound and final-proposal digest fixtures passed');
}
