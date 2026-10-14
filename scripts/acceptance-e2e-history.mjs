#!/usr/bin/env node
// Read-only historical E2E evidence bound to the current PR's real Git
// ancestry and trusted acceptance-results records; never scrape Issue prose.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_COMMITS = 8;
const MAX_RUNS = 12;

export function sourceCommits(workspace, baseSha, headSha, exec = execFileSync) {
  if (!HEX40.test(baseSha) || !HEX40.test(headSha)) return [];
  try {
    exec('git',['-C',workspace,'merge-base','--is-ancestor',baseSha,headSha],
      {encoding:'utf8'});
  } catch { return []; }
  const output=exec('git',['-C',workspace,'rev-list','--first-parent',
    '--max-count='+MAX_COMMITS,headSha,'^'+baseSha],{encoding:'utf8'});
  const shas=String(output).trim().split('\n').filter(Boolean);
  if(shas.some(sha=>!HEX40.test(sha)))throw Error('invalid Git commit ancestry');
  return [...new Set(shas)];
}

export function eligibleE2ERun(run, sha, prNumber) {
  return HEX40.test(sha) && Number.isSafeInteger(prNumber) && prNumber>0 &&
    run?.head_sha===sha && run?.path==='.github/workflows/e2e-tests.yml' &&
    run?.event==='pull_request' && run?.status==='completed' &&
    ['success','failure'].includes(run?.conclusion) &&
    Number.isSafeInteger(Number(run?.id)) && Number(run.id)>0 &&
    Number.isSafeInteger(Number(run?.run_attempt)) &&
    Number(run.run_attempt)>0 &&
    Array.isArray(run?.pull_requests) &&
    run.pull_requests.some(p=>Number(p.number)===prNumber);
}

export function verifiedHistoricalRecord(run,record,prNumber) {
  if(!eligibleE2ERun(run,run?.head_sha,prNumber) ||
    record?.schema_version!==1 || record?.kind!=='issue_e2e_run' ||
    record.target_sha!==run.head_sha || record.run_id!==run.id ||
    record.run_attempt!==run.run_attempt || !HEX64.test(record.plan_digest) ||
    !/^sha256:[a-f0-9]{64}$/.test(record.artifact_digest) ||
    !Array.isArray(record.results) || !record.results.length ||
    record.results.length>100)throw Error('untrusted historical E2E run record');
  const seen=new Set();
  const results=record.results.map(row=>{
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row?.id??'') ||
      seen.has(row.id) || !['Pass','Fail','Pending','Error'].includes(row.result) ||
      !Number.isSafeInteger(row.discovered) || row.discovered<0 ||
      !Number.isSafeInteger(row.assertions) || row.assertions<0)
      throw Error('invalid historical per-ID result');
    seen.add(row.id);
    if(row.result==='Pass' && !(row.discovered>0 &&
      row.passed===row.discovered && row.failed===0 &&
      row.skipped===0 && row.flaky===0 && row.assertions>0))
      throw Error('historical Pass has no executed assertion proof');
    return {id:row.id,result:row.result,discovered:row.discovered,
      assertions:row.assertions};
  });
  return {pr_number:prNumber,target_sha:run.head_sha,run_id:run.id,
    run_attempt:run.run_attempt,run_conclusion:run.conclusion,
    plan_digest:record.plan_digest,artifact_digest:record.artifact_digest,
    results,provenance:'GitHub workflow_run + acceptance-results orphan record'};
}

async function fetchRunRecord(repo,run,githubGet) {
  const date=String(run.created_at??'').slice(0,10);
  const attempt=Number(run.run_attempt);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isSafeInteger(attempt) || attempt<1 || attempt>20)return null;
  const location='runs/'+date+'/'+run.id+'-'+attempt+'/test/issue-e2e.json';
  let data;
  try {
    data=await githubGet('/repos/'+repo+'/contents/'+location+
      '?ref=acceptance-results');
  } catch(e) {
    if(/GitHub API 404\b/.test(String(e.message)))return null;
    throw e;
  }
  if(data?.encoding!=='base64' || typeof data.content!=='string' ||
    data.size>32768)throw Error('untrusted persisted E2E response');
  const bytes=Buffer.from(data.content.replace(/\s/g,''),'base64');
  if(bytes.length>32768)throw Error('oversized E2E record');
  return JSON.parse(bytes.toString('utf8'));
}

export async function collectHistoricalE2E({
  repo,workspace,targetSha,pulls,githubGet,runsForSha,gitExec=execFileSync,
}) {
  const relevant=(Array.isArray(pulls)?pulls:[])
    .filter(p=>p?.state==='open' && p?.head?.sha===targetSha &&
      HEX40.test(p.base?.sha??'') && Number.isSafeInteger(p.number)).slice(0,5);
  const history=[],seen=new Set();
  for(const pr of relevant) {
    const commits=sourceCommits(workspace,pr.base.sha,targetSha,gitExec);
    for(const sha of commits) {
      const runs=(await runsForSha(repo,sha))
        .filter(run=>eligibleE2ERun(run,sha,pr.number)).slice(0,3);
      for(const run of runs) {
        const key=run.id+'/'+run.run_attempt;
        if(seen.has(key))continue;
        seen.add(key);
        const stored=await fetchRunRecord(repo,run,githubGet);
        if(!stored)continue; // Absence is never a Pass.
        history.push(verifiedHistoricalRecord(run,stored,pr.number));
        if(history.length>=MAX_RUNS)return history;
      }
    }
  }
  return history;
}

function selfTest(){
  const sha='a'.repeat(40),base='b'.repeat(40);
  const run={id:123,run_attempt:1,head_sha:sha,
    path:'.github/workflows/e2e-tests.yml',event:'pull_request',
    status:'completed',conclusion:'success',pull_requests:[{number:1718}]};
  const record={schema_version:1,kind:'issue_e2e_run',target_sha:sha,
    run_id:123,run_attempt:1,plan_digest:'c'.repeat(64),
    artifact_digest:'sha256:'+'d'.repeat(64),
    results:[{id:'login',result:'Pass',discovered:1,passed:1,failed:0,
      skipped:0,flaky:0,assertions:2}]};
  assert.deepEqual(verifiedHistoricalRecord(run,record,1718).results,
    [{id:'login',result:'Pass',discovered:1,assertions:2}]);
  assert.throws(()=>verifiedHistoricalRecord(run,{...record,target_sha:base},1718),/untrusted/);
  assert.throws(()=>verifiedHistoricalRecord(run,{...record,
    results:[{...record.results[0],assertions:0}]},1718),/assertion proof/);
  assert.throws(()=>verifiedHistoricalRecord(run,{...record,
    results:[record.results[0],record.results[0]]},1718),/invalid historical/);
  assert.equal(eligibleE2ERun({...run,pull_requests:[{number:1}]},sha,1718),false);
  assert.equal(eligibleE2ERun({...run,event:'push'},sha,1718),false);
  const fakeExec=(program,args)=>{
    if(args.includes('--is-ancestor'))return '';
    return sha+'\n';
  };
  assert.deepEqual(sourceCommits('/repo',base,sha,fakeExec),[sha]);
  assert.deepEqual(sourceCommits('/repo',base,sha,()=>{throw Error('not ancestor');}),[]);
  assert.deepEqual(sourceCommits('/repo','invalid',sha,fakeExec),[]);
  console.log('Historical E2E evidence: SHA/PR ancestry, trusted run, orphan record and forged Pass negatives passed');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]==='self-test')selfTest();
  else throw Error('usage: acceptance-e2e-history.mjs self-test');
}
