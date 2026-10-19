// Read-only, anonymous, exact-deployment public E2E *source coverage* proof.
// The canonical Acceptance updater owns SC verdicts; a visible E2E Pass is
// never upgraded to an SC Pass by this observer.
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {attestPagesDeployment} from './acceptance-pages-deployment-receipt.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const PUBLIC='https://bestnathan.github.io/nession/data/site.json';
const MAX_BYTES=2*1024*1024;
const safePositive=n=>Number.isSafeInteger(n)&&n>0;
const SUPPORTED_POST_MERGE_ISSUES=new Set(['1946','1977']);
// Only the source-owning parent and this same source-attester child consume
// the real published observation. No PR-stage or arbitrary Issue may claim it.
export function shouldCollectPublicPagesE2E(stage,issue) {
  return stage==='post-merge'&&SUPPORTED_POST_MERGE_ISSUES.has(String(issue));
}


// Never send the GitHub token to a public (possibly redirected) endpoint.
async function fetchAnonymousPublic(sha) {
  const response=await fetch(PUBLIC+'?revision='+sha,{
    method:'GET',redirect:'error',cache:'no-store',credentials:'omit',
    headers:{'Cache-Control':'no-cache','Accept':'application/json'},
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok || response.url!==PUBLIC+'?revision='+sha ||
     !response.body)throw Error('public Pages readback unavailable');
  const sizeHeader=Number(response.headers.get('content-length')||0);
  if(sizeHeader>MAX_BYTES)throw Error('public Pages JSON too large');
  const chunks=[];let total=0;
  for await(const chunk of response.body){
    total+=chunk.byteLength;
    if(total>MAX_BYTES)throw Error('public Pages JSON too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function attestPublicPagesE2E(repo,sha,run,jobs,publisherLog,publicBytes){
  // The shared source attester validates same-repo main-push Run/Attempt,
  // unique completed Build/Publish jobs, upload, and successful HTTPS+digest
  // validation. Publisher log supplies exact bytes' independent SHA-256.
  const proof=attestPagesDeployment(repo,sha,run,jobs,publisherLog);
  if(!Buffer.isBuffer(publicBytes) || publicBytes.length<2 ||
     publicBytes.length>MAX_BYTES)throw Error('invalid bounded public JSON');
  if(createHash('sha256').update(publicBytes).digest('hex')!==proof.digest)
    throw Error('public Pages JSON digest mismatch');
  let data;
  try{data=JSON.parse(publicBytes.toString('utf8'));}
  catch{throw Error('invalid public Pages JSON');}
  const source=data?.source, evidence=data?.work?.acceptance_e2e;
  if(data?.schema_version!==1||source?.repository!==REPO||
     source?.main_sha!==sha||!SHA.test(source?.acceptance_results_sha??'')||
     !['available','truncated','unavailable'].includes(evidence?.status)||
     !Array.isArray(evidence?.records)||evidence.records.length>24)
     throw Error('public Pages E2E source identity mismatch');
  if(evidence.status==='unavailable'){
    if(evidence.source_sha!==null||evidence.records.length!==0)
      throw Error('forged unavailable E2E source');
    return null; // No independent canonical E2E source: Unknown, not zero.
  }
  if(evidence.source_sha!==source.acceptance_results_sha)
    throw Error('pinned E2E source SHA drift');
  // "truncated" is source-window coverage only. A current open PR can have
  // zero matching receipts despite older exact-head runs having passed.
  return Object.freeze({
    schema_version:1,kind:'verified_public_pages_e2e_observation',
    target_sha:sha,run_id:proof.run_id,run_attempt:proof.run_attempt,
    build_job_id:proof.build_job_id,publish_job_id:proof.publish_job_id,
    public_json_sha256:proof.digest,
    acceptance_results_sha:source.acceptance_results_sha,
    e2e_source_status:evidence.status,published_e2e_ids:evidence.records.length,
    source_url:'https://github.com/'+repo+'/actions/runs/'+proof.run_id,
    public_url:PUBLIC,source_coverage_only:true,
    establishes_e2e_pass:false,establishes_sc_verdict:false,
    implements_pr_linkage:false,
  });
}

export async function collectPublicPagesE2E(repo,sha,runs,
 request,readJobLog,readPublic=fetchAnonymousPublic){
  if(repo!==REPO||!SHA.test(sha)||!Array.isArray(runs))
    throw Error('invalid public Pages E2E observation request');
  const eligible=runs.filter(r=>r?.name==='Deploy / Public Pages'&&
      r.path==='.github/workflows/deploy-pages.yml'&&
      r.head_sha===sha&&r.status==='completed'&&r.conclusion==='success')
      .sort((a,b)=>b.id-a.id).slice(0,3);
  for(const item of eligible){
    try{
      const run=await request('/repos/'+repo+'/actions/runs/'+item.id);
      if(run.id!==item.id)throw Error('public Pages Run mismatch');
      const jobs=await request('/repos/'+repo+'/actions/runs/'+run.id+
        '/attempts/'+run.run_attempt+'/jobs?per_page=100');
      const publish=jobs.jobs?.filter(j=>j.name==='Publish independent Pages'&&
        j.run_id===run.id&&j.run_attempt===run.run_attempt);
      if(publish?.length!==1||!safePositive(publish[0].id))
        throw Error('public Pages publisher identity missing');
      const log=await readJobLog('/repos/'+repo+'/actions/jobs/'+publish[0].id+'/logs');
      // Refuse to trust mutable client snapshots: this exact public SHA-256
      // must match the independently recorded exact-attempt publisher digest.
      const bytes=await readPublic(sha);
      const attested=attestPublicPagesE2E(repo,sha,run,jobs,log,bytes);
      if(attested)return [attested];
    }catch(error){
      // Ordinary unavailable/stale sites cannot block unrelated Acceptance
      // criteria or be promoted to a successful source observation.
      console.error('Pages E2E source not independently observed:',error.message);
    }
  }
  return [];
}

export async function selfTestPublicPagesE2E(){
  assert.equal(shouldCollectPublicPagesE2E('post-merge','1946'),true);
  assert.equal(shouldCollectPublicPagesE2E('post-merge','1977'),true);
  assert.equal(shouldCollectPublicPagesE2E('pre-merge','1977'),false);
  assert.equal(shouldCollectPublicPagesE2E('post-merge','1906'),false);
  const sha='a'.repeat(40),src='b'.repeat(40);
  const run={id:81,run_attempt:2,name:'Deploy / Public Pages',
    path:'.github/workflows/deploy-pages.yml',event:'push',head_branch:'main',
    head_sha:sha,status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const step=name=>({name,conclusion:'success'});
  const jobs={jobs:[
    {id:7,run_id:81,run_attempt:2,head_sha:sha,name:'Build independent Pages',
      status:'completed',conclusion:'success',
      steps:[step('Upload standalone Pages'),step('Capture exact static public evidence digest and coverage')]},
    {id:8,run_id:81,run_attempt:2,head_sha:sha,name:'Publish independent Pages',
      status:'completed',conclusion:'success',
      steps:[step('Deploy GitHub Pages'),step('Verify public site URL and exact deployed main SHA')]},
  ]};
  const json={schema_version:1,source:{repository:REPO,main_sha:sha,acceptance_results_sha:src},
    work:{acceptance_e2e:{status:'truncated',source_sha:src,records:[]}}};
  const bytes=Buffer.from(JSON.stringify(json));
  const digest=createHash('sha256').update(bytes).digest('hex');
  const log='2026-10-19T02:44:45.3728046Z Public Issue Agent Run observation: source_backed_observation (source=truncated, runs=24, digest='+digest+')\n';
  const prove=(data=json,r=run,j=jobs,l=log,raw=null)=>{
    const b=raw??Buffer.from(JSON.stringify(data));
    return attestPublicPagesE2E(REPO,sha,r,j,l,b);
  };
  const result=prove();
  assert.equal(result.kind,'verified_public_pages_e2e_observation');
  assert.equal(result.e2e_source_status,'truncated');
  assert.equal(result.published_e2e_ids,0);
  assert.equal(result.establishes_sc_verdict,false);
  assert.equal(result.establishes_e2e_pass,false);
  // A trustworthy *available* source may legitimately have no matching
  // current PR-head IDs. The source is observed, not a fabricated Test Pass.
  const available={...json,work:{acceptance_e2e:{status:'available',source_sha:src,records:[]}}};
  const availableDigest=createHash('sha256').update(JSON.stringify(available)).digest('hex');
  const availableProof=prove(available,run,jobs,log.replace(digest,availableDigest));
  assert.equal(availableProof.e2e_source_status,'available');
  assert.equal(availableProof.published_e2e_ids,0);
  assert.equal(availableProof.establishes_sc_verdict,false);

  assert.equal(prove({...json,work:{acceptance_e2e:{status:'unavailable',source_sha:null,records:[]}}},
    run,jobs,log.replace(digest,createHash('sha256').update(JSON.stringify(
      {...json,work:{acceptance_e2e:{status:'unavailable',source_sha:null,records:[]}}})).digest('hex'))),null);
  const invalid=[
    [{...json,source:{...json.source,main_sha:'c'.repeat(40)}}],
    [{...json,source:{...json.source,acceptance_results_sha:'c'.repeat(40)}}],
    [{...json,work:{acceptance_e2e:{status:'truncated',source_sha:'c'.repeat(40),records:[]}}}],
    [{...json,work:{acceptance_e2e:{status:'verified',source_sha:src,records:[]}}}],
    [json,{...run,run_attempt:1}],
    [json,{...run,event:'pull_request'}],
    [json,{...run,repository:{full_name:'other/repo'}}],
    [json,run,{jobs:jobs.jobs.slice(1)}],
    [json,run,{jobs:[...jobs.jobs,jobs.jobs[1]]}],
  ];
  for(const [data,r=run,j=jobs] of invalid)
    assert.throws(()=>prove(data,r,j),/mismatch|attested|digest/);
  assert.throws(()=>prove(json,run,jobs,log,Buffer.concat([bytes,Buffer.from('x')])),/digest/);
  assert.throws(()=>prove(json,run,jobs,log,Buffer.alloc(MAX_BYTES+1)),/bounded/);
  assert.throws(()=>prove(json,run,jobs,log.replace('runs=24','runs=0')),/forged/);
  assert.throws(()=>prove(json,run,jobs,log+log),/ambiguous/);
  const request=async p=>p.endsWith('/81')?run:jobs;
  const reader=async()=>log;
  assert.equal((await collectPublicPagesE2E(REPO,sha,[run],request,reader,async()=>bytes)).length,1);
  assert.deepEqual(await collectPublicPagesE2E(REPO,sha,[run],request,reader,async()=>Buffer.from('{}')),[]);
  assert.deepEqual(await collectPublicPagesE2E(REPO,sha,[{...run,head_sha:'c'.repeat(40)}],request,reader,async()=>bytes),[]);
  return true;
}
