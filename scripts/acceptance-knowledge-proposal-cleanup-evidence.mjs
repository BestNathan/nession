#!/usr/bin/env node
// #3773: read-only, exact-run attestation of the already completed Knowledge
// proposal disposal. It never grants an Acceptance verdict or writes a ref.
import assert from 'node:assert/strict';

const REPO = 'BestNathan/nession';
const SHA = /^[a-f0-9]{40}$/;
const PIN = Object.freeze({
  issue:3773,
  main:'78169984d49eb17ad327fcc617df7e429469051d',
  run:44006544095,
  job:133783167011,
  ledger:'af6016dd1222aeb40563daccb57836ba9303bb59',
  refs:Object.freeze({
    'refs/heads/knowledge-proposals/3693-composition-ownership':'af6016dd1222aeb40563daccb57836ba9303bb59',
    'refs/heads/knowledge-proposals/3693-erofs-image-sandbox-mount-ownership':'9b32b677c69dcedad6c452a9c34edff3628e1222',
    'refs/heads/knowledge-proposals/kb-3581-bounded-github-evidence':'f03dd603c5677781ac51de78ded173ff573a4583',
    'refs/heads/knowledge-proposals/kb-3600-claude-mcp':'32bf410138caa66c27cf4e8678766aa6825f6d45',
  }),
});
const requiredSteps=[
  'Checkout exact trusted main cleanup implementation',
  'Verify cleanup contract and effective Knowledge writer protection',
  'Mint dedicated Knowledge App token for bounded disposal',
  'Delete already published proposals with exact-SHA ref leases',
];
function check(ok,why){if(!ok)throw Error('knowledge proposal GC evidence: '+why);}
export function shouldCollectProposalCleanup(issue,stage){
  return String(issue)===String(PIN.issue)&&stage==='post-merge';
}
function oneStep(job,name){
  const matches=job?.steps?.filter(s=>s.name===name);
  check(matches?.length===1&&matches[0].status==='completed'&&
    matches[0].conclusion==='success','missing/failed step: '+name);
}
function observedLog(log){
  check(typeof log==='string'&&log.length<1024*1024,'missing or unbounded job log');
  // The only attested result is the actual JSON emitted by the privileged
  // cleanup job, not a PR description, Issue comment or arbitrary artifact.
  const lines=log.split(/\r?\n/).map(line=>
    /^\d{4}-\d\d-\d\dT\S+Z (\{"knowledge_sha":.*\})$/.exec(line)?.[1])
    .filter(Boolean);
  check(lines.length===1,'missing or ambiguous cleanup result');
  let result;
  try{result=JSON.parse(lines[0]);}catch{throw Error('malformed cleanup JSON');}
  check(result.knowledge_sha===PIN.ledger&&result.scanned===4&&
    Array.isArray(result.deleted)&&result.deleted.length===4&&
    Array.isArray(result.skipped)&&result.skipped.length===0&&
    Array.isArray(result.failed)&&result.failed.length===0,
    'incomplete or failed proposal deletion');
  const expected=Object.entries(PIN.refs).sort(([a],[b])=>a.localeCompare(b));
  const actual=result.deleted.map(x=>[x.ref,x.sha])
    .sort(([a],[b])=>String(a).localeCompare(String(b)));
  check(JSON.stringify(expected)===JSON.stringify(actual),
    'deleted ref/SHA set disagrees with known source tips');
  return result;
}
export function attestKnowledgeProposalCleanup({
  repo,stage,issue,targetSha,targetAncestry,run,jobs,log,remaining,ledger,ancestry,
}){
  const fromImplementation=targetSha===PIN.main ||
    (SHA.test(targetSha)&&targetAncestry?.base_commit?.sha===PIN.main&&
      targetAncestry.merge_base_commit?.sha===PIN.main&&
      targetAncestry.status==='ahead'&&
      targetAncestry.behind_by===0);
  check(shouldCollectProposalCleanup(issue,stage)&&repo===REPO&&
    fromImplementation,'not the accepted implementation target/descendant');
  check(run?.id===PIN.run&&run.run_attempt===1&&
    run.name==='Store / Knowledge Publisher'&&
    run.path==='.github/workflows/store-knowledge-publisher.yml'&&
    run.event==='push'&&run.head_branch==='main'&&
    run.head_sha===PIN.main&&run.status==='completed'&&
    run.conclusion==='success'&&run.actor?.login==='BestNathan'&&
    run.triggering_actor?.login==='BestNathan'&&
    run.repository?.full_name===REPO&&
    run.head_repository?.full_name===REPO,
    'untrusted source Run/Attempt/Repository/SHA');
  check(Array.isArray(jobs?.jobs)&&jobs.jobs.length===3,
    'incomplete or unexpected workflow jobs');
  const selected=jobs.jobs.filter(x=>x.name==='cleanup');
  check(selected.length===1&&selected[0].id===PIN.job&&
    selected[0].run_id===PIN.run&&selected[0].run_attempt===1&&
    selected[0].head_sha===PIN.main&&
    selected[0].status==='completed'&&selected[0].conclusion==='success',
    'cleanup job did not execute successfully at the pinned main SHA');
  for(const name of requiredSteps)oneStep(selected[0],name);
  for(const name of ['verify','publish']){
    const other=jobs.jobs.filter(j=>j.name===name);
    check(other.length===1&&other[0].status==='completed'&&
      other[0].conclusion==='skipped',
      'cleanup push must not also publish new Knowledge');
  }
  observedLog(log);
  check(Array.isArray(remaining)&&remaining.length===0,
    'proposal refs still exist or enumeration is invalid');
  check(ledger?.ref==='refs/heads/knowledge'&&
    ledger.object?.type==='commit'&&ledger.object.sha===PIN.ledger,
    'Knowledge ref changed or its live SHA cannot be read');
  check(Array.isArray(ancestry)&&ancestry.length===4,
    'four independent Knowledge ancestry comparisons required');
  for(let i=0;i<4;i++){
    const [source]=Object.entries(PIN.refs)[i];
    const sourceSha=PIN.refs[source],cmp=ancestry[i];
    check(cmp?.base_commit?.sha===sourceSha&&
      cmp.merge_base_commit?.sha===sourceSha&&
      ['ahead','identical'].includes(cmp.status)&&
      cmp.ahead_by>=0&&cmp.behind_by===0,
      'proposal commit not authenticated as current Knowledge ancestor: '+source);
  }
  return Object.freeze({
    schema_version:1,kind:'verified_knowledge_proposal_cleanup',
    acceptance_target_sha:targetSha,
    source_run_id:run.id,source_run_attempt:run.run_attempt,source_job_id:PIN.job,
    source_main_sha:run.head_sha,published_knowledge_sha:PIN.ledger,
    deleted_refs:Object.entries(PIN.refs).map(([ref,sha])=>({ref,sha})),
    deleted_count:4,skipped_count:0,failed_count:0,
    remaining_proposal_refs:0,
    knowledge_ref_unchanged:true,
    source_run_url:'https://github.com/'+REPO+'/actions/runs/'+PIN.run,
    source_job_url:'https://github.com/'+REPO+'/actions/runs/'+PIN.run+'/job/'+PIN.job,
    verification:'authenticated run/attempt/job/steps and JSON log, live prefix enumeration, Knowledge HEAD and four Git ancestry comparisons',
    establishes_sc_verdict:false,
  });
}
export async function collectKnowledgeProposalCleanup({
  repo,stage,issue,targetSha,get,getLog,
}){
  if(!shouldCollectProposalCleanup(issue,stage))return null;
  check(repo===REPO&&SHA.test(targetSha),'wrong post-merge target');
  const api='/repos/'+REPO;
  const [run,jobs,remaining,ledger]=await Promise.all([
    get(api+'/actions/runs/'+PIN.run),
    get(api+'/actions/runs/'+PIN.run+'/attempts/1/jobs?per_page=100'),
    get(api+'/git/matching-refs/heads/knowledge-proposals/'),
    get(api+'/git/ref/heads/knowledge'),
  ]);
  const targetAncestry=targetSha===PIN.main?null:
    await get(api+'/compare/'+PIN.main+'...'+targetSha);
  const [log,...ancestry]=await Promise.all([
    getLog(api+'/actions/jobs/'+PIN.job+'/logs'),
    ...Object.values(PIN.refs).map(sha=>
      get(api+'/compare/'+sha+'...'+PIN.ledger)),
  ]);
  return attestKnowledgeProposalCleanup({
    repo,stage,issue,targetSha,targetAncestry,run,jobs,log,remaining,ledger,ancestry,
  });
}
export function selfTestKnowledgeProposalCleanup(){
  const entries=Object.entries(PIN.refs);
  const mock={
    repo:REPO,stage:'post-merge',issue:3773,targetSha:PIN.main,
    run:{id:PIN.run,run_attempt:1,name:'Store / Knowledge Publisher',
      path:'.github/workflows/store-knowledge-publisher.yml',event:'push',
      head_branch:'main',head_sha:PIN.main,status:'completed',conclusion:'success',
      actor:{login:'BestNathan'},triggering_actor:{login:'BestNathan'},
      repository:{full_name:REPO},head_repository:{full_name:REPO}},
    jobs:{jobs:[
      {name:'cleanup',id:PIN.job,run_id:PIN.run,run_attempt:1,
        head_sha:PIN.main,status:'completed',conclusion:'success',
        steps:requiredSteps.map(name=>({name,status:'completed',conclusion:'success'}))},
      {name:'verify',status:'completed',conclusion:'skipped'},
      {name:'publish',status:'completed',conclusion:'skipped'},
    ]},
    log:'2026-11-17T02:56:33.4667993Z '+JSON.stringify({
      knowledge_sha:PIN.ledger,scanned:4,
      deleted:entries.map(([ref,sha])=>({ref,sha})),skipped:[],failed:[],
    })+'\n',
    remaining:[],
    ledger:{ref:'refs/heads/knowledge',object:{type:'commit',sha:PIN.ledger}},
    ancestry:entries.map(([_,sha])=>({status:sha===PIN.ledger?'identical':'ahead',
      base_commit:{sha},merge_base_commit:{sha},
      ahead_by:sha===PIN.ledger?0:1,behind_by:0})),
  };
  const prove=(change={})=>attestKnowledgeProposalCleanup({...mock,...change});
  assert.equal(prove().deleted_count,4);
  assert.equal(prove().establishes_sc_verdict,false);
  assert.equal(prove({targetSha:'c'.repeat(40),targetAncestry:{
    base_commit:{sha:PIN.main},merge_base_commit:{sha:PIN.main},
    status:'ahead',ahead_by:1,behind_by:0,
  }}).deleted_count,4);
  assert.equal(shouldCollectProposalCleanup(3773,'pr'),false);
  assert.equal(shouldCollectProposalCleanup(3156,'post-merge'),false);
  const bad=[
    {targetSha:'f'.repeat(40)},{targetSha:'c'.repeat(40)},{run:{...mock.run,run_attempt:2}},
    {run:{...mock.run,event:'workflow_dispatch'}},
    {run:{...mock.run,head_branch:'staging'}},
    {run:{...mock.run,head_sha:'b'.repeat(40)}},
    {run:{...mock.run,conclusion:'skipped'}},
    {run:{...mock.run,actor:{login:'other'}}},
    {jobs:{jobs:mock.jobs.jobs.map(j=>j.name==='cleanup'?{...j,conclusion:'skipped'}:j)}},
    {jobs:{jobs:mock.jobs.jobs.map(j=>j.name==='cleanup'?{...j,
      steps:j.steps.filter(s=>s.name!==requiredSteps[2])}:j)}},
    {jobs:{jobs:mock.jobs.jobs.map(j=>j.name==='publish'?{...j,conclusion:'success'}:j)}},
    {remaining:[{ref:entries[0][0],object:{sha:entries[0][1]}}]},
    {ledger:{...mock.ledger,object:{type:'commit',sha:'a'.repeat(40)}}},
    {ancestry:mock.ancestry.map((a,i)=>i===0?{...a,status:'diverged'}:a)},
    {ancestry:mock.ancestry.map((a,i)=>i===2?{...a,merge_base_commit:{sha:'b'.repeat(40)}}:a)},
    {log:mock.log.replace('"scanned":4','"scanned":3')},
    {log:mock.log.replace('"skipped":[]','"skipped":[{"ref":"other"}]')},
    {log:mock.log.replace('"failed":[]','"failed":[{"ref":"other"}]')},
    {log:mock.log+mock.log},
    {log:mock.log.replace(entries[0][1],'f'.repeat(40))},
  ];
  for(const c of bad)assert.throws(()=>prove(c));
  return true;
}
if(process.argv[2]==='self-test'){
  selfTestKnowledgeProposalCleanup();
  console.log('knowledge proposal cleanup acceptance: authenticated positive/negative fixtures passed');
}
