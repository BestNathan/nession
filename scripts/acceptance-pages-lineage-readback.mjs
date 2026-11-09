// Read-only, exact-deployment evidence for #3042's historical Qwen lineage.
// The Pages build is the source attester; this adapter proves the actual
// anonymous public bytes are identical to the main-owned published artifact.
// It never sets an Acceptance verdict or trusts a mutable Issue assertion.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {attestPagesDeployment} from './acceptance-pages-deployment-receipt.mjs';
import {fetchAnonymousPublic} from './acceptance-pages-e2e-readback.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const HEX=/^[a-f0-9]{64}$/;
const ISSUE=3001, PR=3017, RUN=42488022265;
const PR_HEAD='2d6f729b94cf4b8a0db73d9c5a60fd1284dd79ed';
const PUBLIC='https://bestnathan.github.io/nession/data/site.json';
const PATH='.github/workflows/deploy-pages.yml';

export function shouldCollectPublicPagesLineage(stage,issue){
  return stage==='post-merge'&&String(issue)==='3042';
}

export function attestPublicPagesLineage(repo,sha,run,jobs,publisherLog,publicBytes){
  // GitHub REST reauthenticates the completed main-push Run/Attempt/Jobs and
  // the publisher's exact anonymous HTTPS site.json SHA-256 observation.
  const proof=attestPagesDeployment(repo,sha,run,jobs,publisherLog);
  if(!Buffer.isBuffer(publicBytes)||publicBytes.length<2||
     publicBytes.length>2*1024*1024||
     createHash('sha256').update(publicBytes).digest('hex')!==proof.digest)
    throw Error('public historical lineage bytes do not match authenticated deployment');
  let json;
  try{json=JSON.parse(publicBytes.toString('utf8'));}
  catch{throw Error('invalid public historical lineage JSON');}
  if(json?.schema_version!==1||json?.source?.repository!==REPO||
     json?.source?.main_sha!==sha)
    throw Error('public historical lineage source identity mismatch');
  const history=json?.work?.lineage;
  // The public lineage contract carries source SHA per edge, not on its
  // parent object. Cross-check with the separately published pinned Store
  // inventory so that an arbitrary edge cannot supply its own source ref.
  const store=json?.evidence?.stores?.find(x=>x.name==='agent-store'&&
    x.state==='present')?.sha;
  if(!['verified','truncated'].includes(history?.status)||
     !SHA.test(store??'')||
     !Array.isArray(history.edges)||history.edges.length<1||history.edges.length>12)
    return null; // No independent Producer proof is Unknown, not Pass.
  // Only the exact independently authenticated Worker/Publisher/Writer/PR
  // result admitted by the main-owned Pages attester is SC-03's target.
  const edges=history.edges.filter(e=>e?.issue===ISSUE&&e?.pr_number===PR);
  if(edges.length!==1)return null;
  const edge=edges[0];
  if(edge.pr_head_sha!==PR_HEAD||edge.role!=='developer'||
     edge.agent_id!=='dev-qwen-01'||edge.run_id!==RUN||edge.attempt!==1||
     edge.verification!=='authenticated_at_attestation'||
     edge.slice_id!==null||!HEX.test(edge.action_id??'')||
     edge.source_ref_sha!==store||
     edge.source_url!=='https://github.com/'+REPO+'/actions/runs/'+RUN)
    return null;
  return Object.freeze({
    schema_version:1,kind:'verified_public_pages_historical_lineage',
    target_sha:sha,run_id:proof.run_id,run_attempt:proof.run_attempt,
    build_job_id:proof.build_job_id,publish_job_id:proof.publish_job_id,
    public_json_sha256:proof.digest,public_url:PUBLIC,
    lineage_status:history.status,source_ref_sha:store,
    issue:ISSUE,pr_number:PR,pr_head_sha:PR_HEAD,
    developer_run_id:RUN,developer_attempt:1,slice_id:null,
    verification:'authenticated_at_attestation',
    source_url:'https://github.com/'+REPO+'/actions/runs/'+proof.run_id,
    verified_by:'exact main-owned GitHub Run/Attempt/Jobs and identical anonymous public Pages SHA-256',
    establishes_sc_verdict:false,
  });
}

export async function collectPublicPagesLineage(repo,sha,runs,get,readJobLog,
  readPublic=fetchAnonymousPublic){
  if(repo!==REPO||!SHA.test(sha)||!Array.isArray(runs))
    throw Error('invalid Pages historical lineage evidence request');
  const candidates=runs.filter(r=>r?.name==='Deploy / Public Pages'&&
    r.path===PATH&&r.head_sha===sha&&r.status==='completed'&&
    r.conclusion==='success').sort((a,b)=>b.id-a.id).slice(0,3);
  for(const candidate of candidates){
    try{
      const run=await get('/repos/'+repo+'/actions/runs/'+candidate.id);
      if(run?.id!==candidate.id)throw Error('historical lineage Run identity mismatch');
      const jobs=await get('/repos/'+repo+'/actions/runs/'+run.id+
        '/attempts/'+run.run_attempt+'/jobs?per_page=100');
      const publishers=jobs.jobs?.filter(j=>j.name==='Publish independent Pages'&&
        j.run_id===run.id&&j.run_attempt===run.run_attempt);
      if(publishers?.length!==1||!Number.isSafeInteger(publishers[0].id)||
         publishers[0].id<1)throw Error('missing unique Pages publisher');
      const log=await readJobLog('/repos/'+repo+'/actions/jobs/'+publishers[0].id+'/logs');
      const bytes=await readPublic(sha);
      const receipt=attestPublicPagesLineage(repo,sha,run,jobs,log,bytes);
      if(receipt)return [receipt];
    }catch(error){
      // Stale/expired/missing or contradictory source cannot promote Pass.
      console.error('Historical Pages lineage not independently observed:',error.message);
    }
  }
  return [];
}

export async function selfTestPublicPagesLineage(){
  assert.equal(shouldCollectPublicPagesLineage('post-merge',3042),true);
  assert.equal(shouldCollectPublicPagesLineage('pre-merge',3042),false);
  assert.equal(shouldCollectPublicPagesLineage('post-merge',1907),false);
  const sha='a'.repeat(40),store='b'.repeat(40);
  const run={id:101,run_attempt:1,name:'Deploy / Public Pages',
    path:PATH,event:'push',head_branch:'main',head_sha:sha,
    status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const steps=names=>names.map(name=>({name,conclusion:'success'}));
  const jobs={jobs:[
    {id:201,name:'Build independent Pages',run_id:101,run_attempt:1,
      head_sha:sha,status:'completed',conclusion:'success',
      steps:steps(['Capture exact static public evidence digest and coverage',
        'Upload standalone Pages'])},
    {id:202,name:'Publish independent Pages',run_id:101,run_attempt:1,
      head_sha:sha,status:'completed',conclusion:'success',
      steps:steps(['Deploy GitHub Pages','Verify public site URL and exact deployed main SHA'])},
  ]};
  const edge={issue:ISSUE,pr_number:PR,pr_head_sha:PR_HEAD,
    role:'developer',agent_id:'dev-qwen-01',run_id:RUN,attempt:1,
    verification:'authenticated_at_attestation',slice_id:null,
    action_id:'c'.repeat(64),source_ref_sha:store,
    source_url:'https://github.com/'+REPO+'/actions/runs/'+RUN};
  const fixture={schema_version:1,source:{repository:REPO,main_sha:sha},
    evidence:{stores:[{name:'agent-store',state:'present',sha:store}]},
    work:{lineage:{status:'verified',edges:[edge]}}};
  const encode=data=>Buffer.from(JSON.stringify(data));
  const logFor=bytes=>'2026-11-09T02:22:51.9441687Z Public Issue Agent Run observation: source_backed_observation (source=truncated, runs=1, digest='+
    createHash('sha256').update(bytes).digest('hex')+')\n';
  const bytes=encode(fixture),log=logFor(bytes);
  const positive=attestPublicPagesLineage(REPO,sha,run,jobs,log,bytes);
  assert.equal(positive.kind,'verified_public_pages_historical_lineage');
  assert.equal(positive.issue,3001);
  assert.equal(positive.pr_number,3017);
  assert.equal(positive.pr_head_sha,PR_HEAD);
  assert.equal(positive.public_json_sha256,
    createHash('sha256').update(bytes).digest('hex'));
  assert.equal(positive.establishes_sc_verdict,false);
  const altered=[{...fixture,work:{lineage:{...fixture.work.lineage,edges:[]}}},
    {...fixture,work:{lineage:{...fixture.work.lineage,status:'unavailable'}}},
    {...fixture,work:{lineage:{...fixture.work.lineage,
      edges:[{...edge,pr_head_sha:'f'.repeat(40)}]}}},
    {...fixture,work:{lineage:{...fixture.work.lineage,
      edges:[{...edge,slice_id:'invented'}]}}},
    {...fixture,work:{lineage:{...fixture.work.lineage,
      edges:[{...edge,verification:'verified_from_issue_text'}]}}},
    {...fixture,work:{lineage:{...fixture.work.lineage,edges:[edge,edge]}}},
  ];
  for(const fake of altered){
    const raw=encode(fake);
    assert.equal(attestPublicPagesLineage(REPO,sha,run,jobs,logFor(raw),raw),null);
  }
  assert.throws(()=>attestPublicPagesLineage(REPO,sha,
    {...run,event:'pull_request'},jobs,log,bytes),/not attested/);
  assert.throws(()=>attestPublicPagesLineage(REPO,sha,run,jobs,log,
    Buffer.concat([bytes,Buffer.from('x')])),/bytes do not match/);
  assert.throws(()=>attestPublicPagesLineage(REPO,sha,run,
    {jobs:jobs.jobs.slice(1)},log,bytes),/not attested/);
  assert.throws(()=>attestPublicPagesLineage(REPO,sha,run,jobs,log+log,bytes),
    /ambiguous/);
  const request=async path=>path.endsWith('/101')?run:jobs;
  assert.equal((await collectPublicPagesLineage(REPO,sha,[run],request,
    async()=>log,async()=>bytes)).length,1);
  assert.deepEqual(await collectPublicPagesLineage(REPO,sha,[run],request,
    async()=>log,async()=>Buffer.from('{}')),[]);
  assert.deepEqual(await collectPublicPagesLineage(REPO,sha,
    [{...run,head_sha:'e'.repeat(40)}],request,
    async()=>log,async()=>bytes),[]);
  return true;
}
