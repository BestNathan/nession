#!/usr/bin/env node
// #1690 SC-07: real GitHub Actions execution of *isolated disposable Git*
// integrity-incident drills. This exercises the canonical live-history
// validator, NOT an unauthorized write to production refs, a WORM anchor,
// a verified writer identity, or an independent external alert channel.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditAnchoredRunStore} from './run-store-integrity.mjs';

const STORE='acceptance-results',REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const fail=s=>{throw Error('run-store-integrity-drill: '+s);};
function git(root,...args){
  return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
    stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0'},
  }).trim();
}
function write(root,name,body){
  const dest=path.join(root,name);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,body,{flag:'w'});
}
function commit(root,msg){
  git(root,'add','-A');
  git(root,'commit','-qm',msg);
  return git(root,'rev-parse','HEAD');
}
export const DRILLS=Object.freeze([
  {id:'immutable_record_overwrite',expected:/forbidden acceptance-results M runs\//},
  {id:'immutable_record_omission',expected:/forbidden acceptance-results D runs\//},
  {id:'sha_index_repoint',expected:/forbidden acceptance-results M indexes\//},
  {id:'non_ancestor_ref_replacement',expected:/baseline is not ancestor of observed ref/},
]);
function runOne(root,id){
  const repo=path.join(root,id);
  fs.mkdirSync(repo,{recursive:true});
  git(repo,'init','-q','--initial-branch='+STORE);
  git(repo,'config','user.name','nession-isolated-drill');
  git(repo,'config','user.email','nession-fixture@example.invalid');
  write(repo,'README.md','isolated fixture\n');
  const baseline=commit(repo,'initial controlled baseline');
  const record='runs/2026-10-15/fixture.json';
  const index='indexes/by-sha/'+('a'.repeat(40))+'/fixture.json';
  write(repo,record,'{"source":"fixture","v":1}\n');
  write(repo,index,'{"record":"fixture","v":1}\n');
  const good=commit(repo,'valid immutable append');
  const valid=auditAnchoredRunStore(repo,STORE,baseline,good);
  if(valid.checked_commits!==1||valid.checked_changes!==2)
    fail('valid append was not accepted before '+id);
  if(id==='immutable_record_overwrite'){
    write(repo,record,'{"source":"forged","v":2}\n');
    commit(repo,'illegal fast-forward record overwrite');
  }else if(id==='immutable_record_omission'){
    git(repo,'rm','-q','--',record);
    commit(repo,'illegal fast-forward record omission');
  }else if(id==='sha_index_repoint'){
    write(repo,index,'{"record":"different","v":2}\n');
    commit(repo,'illegal fast-forward index repoint');
  }else if(id==='non_ancestor_ref_replacement'){
    git(repo,'checkout','-q','--orphan','unrelated');
    git(repo,'rm','-rfq','--','.');
    write(repo,record,'{"source":"replacement","v":99}\n');
    commit(repo,'unrelated replacement orphan history');
    git(repo,'checkout','-q','-B',STORE);
  }else fail('unclassified seeded incident');
  const observed=git(repo,'rev-parse','HEAD');
  if(!SHA.test(baseline)||!SHA.test(observed)||baseline===observed)fail('invalid simulated Git identities');
  const expected=DRILLS.find(d=>d.id===id)?.expected;
  if(!expected)fail('unclassified incident expectation');
  let detected=false,reason=null;
  try{auditAnchoredRunStore(repo,STORE,baseline,observed);}
  catch(e){if(!expected.test(String(e.message)))throw e;detected=true;reason=id;}
  if(!detected)fail('canonical validator missed seeded incident '+id);
  return {id,status:'Detected',expected_violation:reason,
    seed:'disposable_local_git_only',baseline_sha:baseline,observed_sha:observed,
    valid_append_preflight:'Accepted'};
}
export function runDrill(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-run-store-tamper-'));
  try{
    const cases=DRILLS.map(d=>runOne(dir,d.id));
    if(cases.length!==DRILLS.length||cases.some(c=>c.status!=='Detected'))
      fail('incomplete detection coverage');
    return {schema_version:1,kind:'isolated_run_store_integrity_incident_drill',
      repository:REPO,execution_mode:'isolated_disposable_local_git',
      validator:'scripts/run-store-integrity.mjs:auditAnchoredRunStore',
      coverage:cases.length,total:DRILLS.length,
      verdict:'FixtureDetectionPassed',
      production_ref_mutated:false,server_side_denials_verified:false,
      unexpected_writer_identity_verified:false,
      referential_source_integrity_verified:false,
      independent_anchor_verified:false,external_alert_channel_verified:false,
      alert_channel:'GitHub Actions step failure + retained Actions artifact only',
      cases};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function selfTest(){
  const report=runDrill();
  assert.equal(report.verdict,'FixtureDetectionPassed');
  assert.equal(report.coverage,4);
  assert.deepEqual(report.cases.map(c=>c.id),DRILLS.map(d=>d.id));
  assert.ok(report.cases.every(c=>c.status==='Detected'&&
    SHA.test(c.baseline_sha)&&SHA.test(c.observed_sha)&&c.valid_append_preflight==='Accepted'));
  assert.equal(report.production_ref_mutated,false);
  assert.equal(report.external_alert_channel_verified,false);
  const wf=fs.readFileSync('.github/workflows/store-governance-audit.yml','utf8');
  assert.match(wf,/run-store-integrity-drill\.mjs collect/);
  assert.match(wf,/permissions:\s*\n  contents: read\s*\n  actions: read/);
  assert.doesNotMatch(wf,/contents: write|RUN_STORE_WRITER_APP_PRIVATE_KEY/);
  console.log('isolated Git history audit: legitimate append passes; four seeded tamper incidents detected, no production ref or signed anchor asserted');
}
function collect(output){
  if(process.env.GITHUB_REPOSITORY!==REPO||
     process.env.GITHUB_REF!=='refs/heads/main'||
     !SHA.test(process.env.GITHUB_SHA??''))fail('trusted main-only audit context required');
  if(!output||!path.isAbsolute(output)||fs.existsSync(output))
    fail('fresh absolute output is required');
  const report=runDrill();
  report.observed_main_sha=process.env.GITHUB_SHA;
  report.github_run_id=process.env.GITHUB_RUN_ID??null;
  report.github_run_attempt=process.env.GITHUB_RUN_ATTEMPT??null;
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '### Isolated Run Store tamper drill\n\n'+
    report.cases.map(x=>'- '+x.id+': '+x.status+'\n').join('')+
    '\nThis is an isolated fixture, NOT a live denied-write or external/WORM alert proof.\n');
  console.log(JSON.stringify({kind:report.kind,coverage:report.coverage,total:report.total,verdict:report.verdict}));
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    if(process.argv[2]==='self-test')selfTest();
    else if(process.argv[2]==='collect')collect(process.argv[3]);
    else fail('usage: self-test | collect ABS_REPORT');
  }catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
