#!/usr/bin/env node
// Authenticated post-merge scoped report: the artifact is untrusted until
// its GitHub SHA256 and Playwright per-ID assertions are independently read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { collect } from './issue-e2e-collect.mjs';

const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
export function verifyScopeArtifact({plan,results,report,assertions,run,scopeProof}) {
  assert.ok(run&&scopeProof&&plan?.schema_version===1&&
    plan.kind==='issue_e2e_selection'&&plan.target_sha===run.head_sha&&
    results?.kind==='issue_e2e_test_results'&&
    results.target_sha===run.head_sha&&
    results.run_id===run.id&&results.run_attempt===run.run_attempt);
  assert.ok(['selected','not-required'].includes(plan.mode));
  assert.equal(plan.mode,scopeProof.scope);
  assert.ok(Array.isArray(plan.selected)&&Array.isArray(plan.issues));
  if(plan.mode==='selected'){
    const ids=plan.selected.map(item=>item.id);
    assert.ok(ids.length>0&&new Set(ids).size===ids.length);
    assert.deepEqual([...ids].sort(),scopeProof.receipt.selected_ids);
    assert.match(plan.plan_digest,/^[a-f0-9]{64}$/);
    const recomputed=collect(plan,report,assertions,run.id,run.run_attempt);
    assert.deepEqual(results,recomputed,'untrusted scoped artifact per-ID results');
    assert.equal(results.status,'Pass','selected E2E was not proven Pass');
    assert.ok(results.results.every(row=>row.result==='Pass'&&row.assertions>0&&
      row.discovered>0&&row.skipped===0&&row.flaky===0));
  }else{
    assert.equal(plan.selected.length,0);
    assert.equal(results.status,'NotRequired');
    assert.equal(results.scope,'not-required');
    assert.ok(typeof plan.reason==='string'&&plan.reason.length>5);
    assert.equal(results.run_id,run.id);
    assert.equal(results.run_attempt,run.run_attempt);
  }
  return {scope:plan.mode,target_sha:run.head_sha,
    run_id:run.id,run_attempt:run.run_attempt,
    verified_ids:plan.mode==='selected'?scopeProof.receipt.selected_ids:[],
    plan_digest:plan.plan_digest??null,
    evidence:'authenticated SHA256 artifact + independent per-ID assertions'};
}
function readEntry(zipPath,name){
  const list=spawnSync('unzip',['-Z1',zipPath],{encoding:'utf8',maxBuffer:4*1024*1024});
  if(list.status!==0)throw Error('unreadable scoped GitHub artifact ZIP');
  const paths=list.stdout.trim().split(/\r?\n/);
  if(paths.length>100||paths.some(p=>p.startsWith('/')||p.includes('..')||
    !/^[A-Za-z0-9._/-]+$/.test(p)))throw Error('unsafe scoped ZIP paths');
  const matches=paths.filter(p=>p===name);
  if(matches.length!==1)throw Error('missing or ambiguous scoped artifact '+name);
  const res=spawnSync('unzip',['-p',zipPath,name],{encoding:'utf8',maxBuffer:8*1024*1024});
  if(res.status!==0)throw Error('unable to read scoped artifact '+name);
  return JSON.parse(res.stdout);
}
export async function collectScopeArtifact({run,scopeProof,artifact,token,fetcher=fetch}){
  if(!token||!Number.isSafeInteger(artifact?.artifact_id)||artifact.artifact_id<1||
    !/^[a-f0-9]{64}$/.test(artifact?.sha256??''))
    throw Error('invalid exact scoped artifact identity');
  const response=await fetcher('https://api.github.com/repos/BestNathan/nession/actions/artifacts/'+artifact.artifact_id+'/zip',{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},
    signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('trusted scoped artifact download failed');
  const buf=Buffer.from(await response.arrayBuffer());
  if(buf.length>64*1024*1024||sha256(buf)!==artifact.sha256)
    throw Error('scoped GitHub artifact SHA256 mismatch');
  const dir=mkdtempSync(join(tmpdir(),'nession-scoped-e2e-'));
  try{
    const zipPath=join(dir,'proof.zip');writeFileSync(zipPath,buf);
    const plan=readEntry(zipPath,'plan.json'),results=readEntry(zipPath,'results.json');
    const report=scopeProof.scope==='selected'?readEntry(zipPath,'playwright.json'):null;
    const assertions=scopeProof.scope==='selected'?readEntry(zipPath,'assertions.json'):null;
    return verifyScopeArtifact({plan,results,report,assertions,run,scopeProof});
  }finally{rmSync(dir,{recursive:true,force:true})}
}
function selfTest(){
  const sha='a'.repeat(40),digest='b'.repeat(64);
  const run={id:42,run_attempt:2,head_sha:sha};
  const plan={schema_version:1,kind:'issue_e2e_selection',mode:'not-required',
    target_sha:sha,reason:'trusted metadata-only diff',selected:[],issues:[]};
  const results={schema_version:1,kind:'issue_e2e_test_results',scope:'not-required',
    target_sha:sha,plan_digest:null,run_id:42,run_attempt:2,results:[],status:'NotRequired'};
  const scopeProof={scope:'not-required',receipt:{plan_mode:'not-required'}};
  assert.equal(verifyScopeArtifact({plan,results,run,scopeProof}).scope,'not-required');
  for(const wrong of [
    {run:{...run,head_sha:'c'.repeat(40)}},
    {results:{...results,status:'Pass'}},
    {results:{...results,run_attempt:1}},
    {plan:{...plan,selected:[{id:'login'}]}},
    {scopeProof:{scope:'selected',receipt:{selected_ids:['login']}}},
  ])assert.throws(()=>verifyScopeArtifact({plan,results,run,scopeProof,...wrong}));
  const selected={...plan,mode:'selected',plan_digest:digest,selected:[{id:'login',owners:[]}]};
  const selectedReceipt={scope:'selected',receipt:{selected_ids:['login']}};
  assert.throws(()=>verifyScopeArtifact({plan:selected,results,run,scopeProof:selectedReceipt,
    report:null,assertions:null}),/assertion|untrusted|Pass/);
  console.log('trusted merged scoped artifact: exact SHA, attempt, not-required and negative proof tests passed');
}
if(process.argv[2]==='self-test')selfTest();
