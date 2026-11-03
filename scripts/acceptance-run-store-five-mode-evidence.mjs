// #1690 SC-06: re-evaluate the EXISTING canonical five-mode Git-byte verifier
// in the trusted Acceptance harness. Do not treat an earlier green Workflow
// summary, expired Actions artifact, or Issue report row as durable evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO='BestNathan/nession', SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const MODES=['case','scenario','test','task','agent-metrics'];
const SOURCE=fileURLToPath(new URL('./run-store-five-mode-evidence.mjs',import.meta.url));

function validVerifiedRecord(row){
  return row && row.status==='Verified' &&
    MODES.includes(row.mode) &&
    Number.isSafeInteger(row.source_run_id) && row.source_run_id>0 &&
    Number.isSafeInteger(row.ingest_run_id) && row.ingest_run_id>0 &&
    Number.isSafeInteger(row.readback_run_id) && row.readback_run_id>0 &&
    SHA.test(row.source_sha) && SHA.test(row.commit_sha) &&
    SHA.test(row.ingest_sha) &&
    DIGEST.test(row.publisher_artifact_zip_digest) &&
    DIGEST.test(row.consumer_artifact_zip_digest) &&
    Number.isSafeInteger(row.changed_records) && row.changed_records>0 &&
    Number.isSafeInteger(row.checked_records) &&
    row.checked_records>=row.changed_records &&
    row.trust_level==='github_actions_authenticated_not_independent_anchor';
}

// Does NOT independently attest report JSON. Its authority is the trusted
// main-owned canonical verifier executed by collectFiveModeAcceptanceEvidence.
// Explicit source/target and per-mode checks prevent accidental trust inflation.
export function validateFiveModeAcceptanceReport(report,repo,sha){
  if(repo!==REPO||!SHA.test(sha)||report?.schema_version!==1||
     report.kind!=='five_mode_authenticated_run_store_readback'||
     report.repository!==repo||report.observed_main_sha!==sha||
     report.total!==5||!Number.isSafeInteger(report.coverage)||
     report.coverage<0||report.coverage>5||
     !['Verified','Pending'].includes(report.verdict)||
     report.external_anchor_verified!==false||
     report.authorization_denials_verified!==false||
     !Array.isArray(report.records)||report.records.length!==5)
    throw Error('untrusted five-mode Acceptance report scope');
  if(new Set(report.records.map(row=>row?.mode)).size!==5||
     MODES.some(mode=>!report.records.some(row=>row?.mode===mode))||
     report.records.some(row=>!['Verified','Pending'].includes(row?.status)))
    throw Error('unclassified/duplicate five-mode evidence row');
  const verified=report.records.filter(row=>row.status==='Verified');
  if(verified.some(row=>!validVerifiedRecord(row))||
     verified.length!==report.coverage||
     (report.verdict==='Verified')!==(verified.length===5))
    throw Error('five-mode report coverage/provenance contradiction');
  return {
    schema_version:1,kind:'authenticated_five_mode_run_store_readback',
    observed_main_sha:sha,coverage:verified.length,total:5,
    verdict:report.verdict,
    records:report.records,
    external_anchor_verified:false,authorization_denials_verified:false,
    provenance:'current trusted-main Acceptance reruns canonical five-mode source/ingester/consumer Git-byte verification; Actions artifacts have finite retention',
  };
}

export function eligibleFiveModeAcceptanceScope({repo,sha,issue,stage,githubSha,githubRef}){
  return repo===REPO && SHA.test(sha) &&
    issue===1690 && stage==='post-merge' &&
    githubSha===sha && githubRef==='refs/heads/main';
}

export function collectFiveModeAcceptanceEvidence(scope,run=execFileSync){
  if(!eligibleFiveModeAcceptanceScope(scope))return null;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-1690-five-mode-'));
  try{
    const output=path.join(dir,'report.json');
    // The verifier authenticates the five source->ingester->readback chains,
    // downloads bounded independently checked Git-byte receipts, and fails
    // closed on identity drift. Never substitute Workflow status for its JSON.
    run(process.execPath,[SOURCE,'collect',output],{
      cwd:path.dirname(SOURCE),env:process.env,
      timeout:300000,stdio:['ignore','pipe','pipe'],maxBuffer:512*1024,
    });
    if(!fs.existsSync(output)||fs.lstatSync(output).isSymbolicLink()||
       fs.statSync(output).size>256*1024)
      throw Error('missing/oversized canonical five-mode evidence');
    return validateFiveModeAcceptanceReport(
      JSON.parse(fs.readFileSync(output,'utf8')),scope.repo,scope.sha);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

export function selfTestFiveModeAcceptanceEvidence(){
  const sha='a'.repeat(40),other='b'.repeat(40);
  const base={repo:REPO,sha,issue:1690,stage:'post-merge',
    githubSha:sha,githubRef:'refs/heads/main'};
  assert.equal(eligibleFiveModeAcceptanceScope(base),true);
  for(const change of [
    {issue:1664},{stage:'pre-merge'},{repo:'attacker/repo'},
    {githubSha:other},{githubRef:'refs/heads/feature'},{sha:'not-a-sha'},
  ])assert.equal(eligibleFiveModeAcceptanceScope({...base,...change}),false);
  const row=(mode,index)=>({
    mode,store:mode==='task'?'task-results':mode==='agent-metrics'?'metrics':'acceptance-results',
    status:'Verified',source_run_id:index+1,ingest_run_id:index+11,
    readback_run_id:index+21,source_sha:sha,ingest_sha:sha,
    commit_sha:sha,publisher_artifact_zip_digest:'sha256:'+'c'.repeat(64),
    consumer_artifact_zip_digest:'sha256:'+'d'.repeat(64),
    checked_records:3,changed_records:2,
    trust_level:'github_actions_authenticated_not_independent_anchor',
  });
  const report={schema_version:1,kind:'five_mode_authenticated_run_store_readback',
    repository:REPO,observed_main_sha:sha,total:5,coverage:5,
    verdict:'Verified',external_anchor_verified:false,
    authorization_denials_verified:false,records:MODES.map(row)};
  const verify=value=>validateFiveModeAcceptanceReport(value,REPO,sha);
  assert.equal(verify(report).verdict,'Verified');
  assert.equal(verify(report).external_anchor_verified,false);
  const reject=mut=>assert.throws(()=>verify(mut));
  reject({...report,observed_main_sha:other});
  reject({...report,external_anchor_verified:true});
  reject({...report,authorization_denials_verified:true});
  reject({...report,coverage:4});
  reject({...report,verdict:'Pending'});
  reject({...report,records:[...report.records.slice(0,4),report.records[0]]});
  reject({...report,records:report.records.map((r,i)=>i===0?{...r,changed_records:0}:r)});
  reject({...report,records:report.records.map((r,i)=>i===0?{...r,consumer_artifact_zip_digest:'bad'}:r)});
  const pending={...report,verdict:'Pending',coverage:4,
    records:[...report.records.slice(0,4),
      {mode:'agent-metrics',store:'metrics',status:'Pending',reason:'expired'}]};
  assert.equal(verify(pending).verdict,'Pending');
  let invoked=0;
  const fake=(_node,args)=>{
    invoked++;
    fs.writeFileSync(args[2],JSON.stringify(report));
  };
  assert.equal(collectFiveModeAcceptanceEvidence(base,fake).coverage,5);
  assert.equal(invoked,1);
  assert.equal(collectFiveModeAcceptanceEvidence({...base,issue:42},fake),null);
  assert.equal(invoked,1);
  return true;
}
