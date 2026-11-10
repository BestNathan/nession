// #3224: independent, bounded read-only attestation of #3156's real
// owner-authorized Knowledge Ingest -> protected App -> public Pages chain.
// GitHub IDs are discovery pins only: they cannot confer trust without exact
// native Run/Attempt/Jobs, admitted source receipt and deployed HTTPS proof.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession';
const IMPLEMENTED='549384893535bf574a4acc5d33de0c8a7b5ad3ec';
const SHA=/^[a-f0-9]{40}$/, DIGEST=/^[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const PUBLISHER='Store / Knowledge Publisher';
const PUBLISHER_PATH='.github/workflows/store-knowledge-publisher.yml';
const SIGNAL='Knowledge / Change Signal';
const SIGNAL_PATH='.github/workflows/knowledge-changed.yml';
const PAGES='Deploy / Public Pages';
const PAGES_PATH='.github/workflows/deploy-pages.yml';
// Limited to one observed production transaction. Future receipts require
// independently reviewed pins; never discover candidates by mutable Issue claims.
export const KNOWLEDGE_WITNESS=Object.freeze({
  issue:3156,comment:6772708110,publisher:42853407065,
  signal:42853518021,pages:42853552020,
});

function deny(ok,message){if(!ok)throw Error('knowledge acceptance: '+message);}
function timestamp(s){const t=Date.parse(s);deny(typeof s==='string'&&Number.isFinite(t),'bad time');return t;}
function runCheck(run,id,name,workflow,event,branch,head){
  deny(positive(id)&&run?.id===id&&positive(run.run_attempt)&&
    run.name===name&&run.path===workflow&&run.event===event&&
    run.head_branch===branch&&run.head_sha===head&&SHA.test(head)&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.status==='completed'&&run.conclusion==='success',
    'untrusted '+name+' Run/Attempt');
}
function oneJob(response,run,name,required){
  deny(Array.isArray(response?.jobs)&&response.jobs.length<=30,'unbounded jobs');
  const found=response.jobs.filter(j=>j?.name===name);
  deny(found.length===1,'ambiguous '+name+' job');
  const job=found[0];
  deny(positive(job.id)&&job.run_id===run.id&&
    (job.run_attempt==null||job.run_attempt===run.run_attempt)&&
    job.status==='completed'&&job.conclusion==='success'&&
    Array.isArray(job.steps),'failed '+name+' job');
  for(const requiredName of required){
    const steps=job.steps.filter(s=>s.name===requiredName);
    deny(steps.length===1&&steps[0].status==='completed'&&
      steps[0].conclusion==='success','missing '+name+' step '+requiredName);
  }
  return job.id;
}
function parseAdmission(log){
  deny(typeof log==='string'&&log.length<1024*1024,'unbounded admission log');
  const records=log.split(/\r?\n/).filter(l=>/^\d{4}-\d\d-\d\dT\S+Z \{"schema_version":1,"event":"issue_comment"/.test(l));
  deny(records.length===1,'missing or ambiguous admission receipt');
  const json=records[0].slice(records[0].indexOf('Z ')+2);
  return JSON.parse(json);
}
function parsePolicy(log){
  const rows=log.split(/\r?\n/).filter(l=>
    /^\d{4}-\d\d-\d\dT\S+Z \{.*"result":"active_ruleset_structure_verified_readonly"\}/.test(l));
  deny(rows.length===1,'missing/ambiguous main-owned ruleset preflight');
  return JSON.parse(rows[0].slice(rows[0].indexOf('Z ')+2));
}
function parsePages(log,sha){
  deny(typeof log==='string'&&log.length<1024*1024,'unbounded Pages log');
  const lines=log.split(/\r?\n/).map(s=>s.match(
    /^\d{4}-\d\d-\d\dT\S+Z Public Knowledge verified: source=([a-f0-9]{40}) articles=(\d+) digest=([a-f0-9]{64})$/)).filter(Boolean);
  deny(lines.length===1&&lines[0][1]===sha,'missing or wrong HTTPS source SHA');
  const articles=Number(lines[0][2]),digest=lines[0][3];
  deny(positive(articles)&&DIGEST.test(digest),'bad public Knowledge digest');
  return {articles,digest};
}
export function mainAncestry(compare,base,tip){
  return base===tip||(compare?.merge_base_commit?.sha===base&&
    ['ahead','identical'].includes(compare.status)&&
    compare.base_commit?.sha===base);
}
export function shouldCollectKnowledgePublication(stage,issue){
  return stage==='post-merge'&&['3156','3224'].includes(String(issue));
}
export function attestKnowledgePublication({
  targetSha,comment,publisher,signal,pages,proposalCommit,
  publisherJobs,signalJobs,pagesJobs,verifyLog,publishLog,pagesLog,
  implementedToTarget,implementedToPublisher,targetToPublisher,publisherToTarget,
}){
  const pins=KNOWLEDGE_WITNESS;
  deny(SHA.test(targetSha)&&mainAncestry(implementedToTarget,IMPLEMENTED,targetSha),
    'Acceptance target does not include implementing fix');
  deny(comment?.id===pins.comment&&comment.user?.login==='BestNathan'&&
    comment.author_association==='OWNER'&&
    comment.issue_url==='https://api.github.com/repos/'+REPO+'/issues/'+pins.issue&&
    timestamp(comment.created_at)===timestamp(comment.updated_at),
    'untrusted or edited owner comment');
  const lines=String(comment.body||'').replace(/\r\n?/g,'\n').trimEnd().split('\n');
  deny(lines.length===4&&lines[0]==='/knowledge-publish v1'&&
    /^proposal_ref=refs\/heads\/knowledge-proposals\/[a-z0-9-]+$/.test(lines[1])&&
    /^proposal_sha=[a-f0-9]{40}$/.test(lines[2])&&
    /^expected_head=[a-f0-9]{40}$/.test(lines[3]),
    'malformed owner publication command');
  const ref=lines[1].slice('proposal_ref='.length);
  const source=lines[2].slice('proposal_sha='.length);
  const previous=lines[3].slice('expected_head='.length);
  deny(source!==previous&&proposalCommit?.sha===source&&
    proposalCommit.parents?.length===1&&proposalCommit.parents[0].sha===previous,
    'proposal not exactly one direct child');
  deny(SHA.test(publisher?.head_sha),'missing publisher main source');
  const main=publisher.head_sha;
  deny(mainAncestry(implementedToPublisher,IMPLEMENTED,main)&&
    (mainAncestry(targetToPublisher,targetSha,main)||
      mainAncestry(publisherToTarget,main,targetSha)),
    'Publisher main source unrelated to accepted implementation');
  runCheck(publisher,pins.publisher,PUBLISHER,PUBLISHER_PATH,'issue_comment','main',main);
  deny(publisher.actor?.login==='BestNathan'&&
    publisher.triggering_actor?.login==='BestNathan'&&publisher.run_attempt===1&&
    timestamp(comment.created_at)<=timestamp(publisher.created_at),
    'publisher not authorized by owner comment');
  const verification=oneJob(publisherJobs,publisher,'verify',[
    'Verify only authenticated owner/main requests and valid inert data']);
  const publication=oneJob(publisherJobs,publisher,'publish',[
    'Reverify source and effective GitHub protection before App token',
    'Mint dedicated Knowledge App token only after admission',
    'Publish one non-force validated fast-forward and verify GitHub SHA',
    'Preserve bounded sanitized publication evidence']);
  const proof=parseAdmission(verifyLog),repeat=parseAdmission(publishLog);
  for(const r of [proof,repeat])deny(
    r.schema_version===1&&r.event==='issue_comment'&&
    r.source_comment_id===pins.comment&&r.source_run_id===null&&
    r.source_ref===ref&&r.source_sha===source&&r.expected_head===previous&&
    r.trusted_main_sha===main&&String(r.run_id)===String(publisher.id)&&
    String(r.run_attempt)===String(publisher.run_attempt)&&
    r.status==='validated_no_write',
    'publisher admission receipt does not match authenticated source');
  const policy=parsePolicy(publishLog);
  deny(policy.app_id===5677350&&policy.writer_ruleset_id===26835890&&
    policy.append_only_ruleset_id===26836090&&
    policy.result==='active_ruleset_structure_verified_readonly',
    'protected writer policy does not match expected App/rulesets');
  runCheck(signal,pins.signal,SIGNAL,SIGNAL_PATH,'push','knowledge',source);
  deny(signal.actor?.login==='nession-knowledge-publisher[bot]'&&
    signal.run_attempt===1&&timestamp(signal.created_at)>=timestamp(publisher.created_at),
    'orphan push not authenticated to dedicated App');
  oneJob(signalJobs,signal,'signal',['Record Knowledge revision']);
  runCheck(pages,pins.pages,PAGES,PAGES_PATH,'workflow_run','main',main);
  deny(pages.run_attempt===1&&
    pages.actor?.login===signal.actor.login&&
    timestamp(pages.created_at)>=timestamp(signal.created_at),
    'Pages not sourced from the Knowledge notifier');
  const build=oneJob(pagesJobs,pages,'Build independent Pages',[
    'Validate Knowledge ledger at pinned checkout','Validate independent public projection',
    'Capture exact static public evidence digest and coverage','Upload standalone Pages']);
  const publish=oneJob(pagesJobs,pages,'Publish independent Pages',[
    'Deploy GitHub Pages','Verify public site URL and exact deployed main SHA']);
  const publicSource=parsePages(pagesLog,source);
  return Object.freeze({
    schema_version:1,kind:'verified_knowledge_publisher_publication',
    acceptance_target_sha:targetSha,implemented_sha:IMPLEMENTED,
    publisher_main_sha:main,owner_issue_number:pins.issue,
    owner_comment_id:pins.comment,
    proposal_ref:ref,previous_knowledge_sha:previous,
    published_knowledge_sha:source,
    publisher_run_id:publisher.id,publisher_run_attempt:publisher.run_attempt,
    verifier_job_id:verification,protected_app_job_id:publication,
    knowledge_signal_run_id:signal.id,
    pages_run_id:pages.id,pages_run_attempt:pages.run_attempt,
    pages_build_job_id:build,pages_publish_job_id:publish,
    public_articles:publicSource.articles,
    public_knowledge_sha256:publicSource.digest,
    evidence_url:'https://github.com/'+REPO+'/actions/runs/'+publisher.id,
    public_url:'https://bestnathan.github.io/nession/data/knowledge.json',
    verified_by:'GitHub exact Run/Attempt/Jobs and main ancestry; immutable admission, protected App and HTTPS publisher logs',
    establishes_sc_verdict:false,
  });
}

export async function collectKnowledgePublication({repo,targetSha,stage,issue,get,getLog}){
  if(!shouldCollectKnowledgePublication(stage,issue))return [];
  deny(repo===REPO&&SHA.test(targetSha),'invalid evidence collection scope');
  const p=KNOWLEDGE_WITNESS;
  const path='/repos/'+REPO;
  const [comment,publisher,signal,pages]=await Promise.all([
    get(path+'/issues/comments/'+p.comment),
    get(path+'/actions/runs/'+p.publisher),
    get(path+'/actions/runs/'+p.signal),
    get(path+'/actions/runs/'+p.pages)]);
  deny(SHA.test(publisher?.head_sha),'untrusted Publisher main identity');
  const main=publisher.head_sha;
  const [proposalCommit,publisherJobs,signalJobs,pagesJobs,
    implementedToTarget,implementedToPublisher]=await Promise.all([
    get(path+'/commits/'+String(comment?.body||'').match(/^proposal_sha=([a-f0-9]{40})$/m)?.[1]),
    get(path+'/actions/runs/'+p.publisher+'/attempts/'+publisher.run_attempt+'/jobs?per_page=100'),
    get(path+'/actions/runs/'+p.signal+'/attempts/'+signal.run_attempt+'/jobs?per_page=100'),
    get(path+'/actions/runs/'+p.pages+'/attempts/'+pages.run_attempt+'/jobs?per_page=100'),
    get(path+'/compare/'+IMPLEMENTED+'...'+targetSha),
    get(path+'/compare/'+IMPLEMENTED+'...'+main)]);
  const find=(jobs,name)=>{const a=jobs?.jobs?.filter(j=>j.name===name);
    deny(a?.length===1&&positive(a[0].id),'missing exact log producer '+name);
    return a[0].id;};
  const [verifyLog,publishLog,pagesLog]=await Promise.all([
    getLog(path+'/actions/jobs/'+find(publisherJobs,'verify')+'/logs'),
    getLog(path+'/actions/jobs/'+find(publisherJobs,'publish')+'/logs'),
    getLog(path+'/actions/jobs/'+find(pagesJobs,'Publish independent Pages')+'/logs')]);
  const targetToPublisher=targetSha===main?null:
    await get(path+'/compare/'+targetSha+'...'+main);
  const publisherToTarget=targetSha===main?null:
    await get(path+'/compare/'+main+'...'+targetSha);
  return [attestKnowledgePublication({
    targetSha,comment,publisher,signal,pages,proposalCommit,
    publisherJobs,signalJobs,pagesJobs,verifyLog,publishLog,pagesLog,
    implementedToTarget,implementedToPublisher,targetToPublisher,publisherToTarget,
  })];
}

export function selfTestKnowledgePublication(){
  const base='a'.repeat(40),main='b'.repeat(40),head='c'.repeat(40),
    published='d'.repeat(40),digest='e'.repeat(64);
  const p=KNOWLEDGE_WITNESS;
  const original={
    targetSha:IMPLEMENTED,
    comment:{id:p.comment,user:{login:'BestNathan'},author_association:'OWNER',
      issue_url:'https://api.github.com/repos/'+REPO+'/issues/3156',
      created_at:'2026-11-10T10:00:00Z',updated_at:'2026-11-10T10:00:00Z',
      body:'/knowledge-publish v1\nproposal_ref=refs/heads/knowledge-proposals/proof\n'+
        'proposal_sha='+published+'\nexpected_head='+base},
    publisher:{id:p.publisher,name:PUBLISHER,path:PUBLISHER_PATH,event:'issue_comment',
      head_branch:'main',head_sha:main,repository:{full_name:REPO},
      head_repository:{full_name:REPO},actor:{login:'BestNathan'},
      triggering_actor:{login:'BestNathan'},run_attempt:1,
      status:'completed',conclusion:'success',created_at:'2026-11-10T10:01:00Z'},
    signal:{id:p.signal,name:SIGNAL,path:SIGNAL_PATH,event:'push',
      head_branch:'knowledge',head_sha:published,repository:{full_name:REPO},
      head_repository:{full_name:REPO},actor:{login:'nession-knowledge-publisher[bot]'},
      run_attempt:1,status:'completed',conclusion:'success',
      created_at:'2026-11-10T10:02:00Z'},
    pages:{id:p.pages,name:PAGES,path:PAGES_PATH,event:'workflow_run',
      head_branch:'main',head_sha:main,repository:{full_name:REPO},
      head_repository:{full_name:REPO},actor:{login:'nession-knowledge-publisher[bot]'},
      run_attempt:1,status:'completed',conclusion:'success',
      created_at:'2026-11-10T10:03:00Z'},
    proposalCommit:{sha:published,parents:[{sha:base}]},
    implementedToTarget:{base_commit:{sha:IMPLEMENTED},merge_base_commit:{sha:IMPLEMENTED},status:'identical'},
    implementedToPublisher:{base_commit:{sha:IMPLEMENTED},merge_base_commit:{sha:IMPLEMENTED},status:'ahead'},
    targetToPublisher:{base_commit:{sha:IMPLEMENTED},merge_base_commit:{sha:IMPLEMENTED},status:'ahead'},
    publisherToTarget:null,
  };
  const steps=names=>names.map(name=>({name,status:'completed',conclusion:'success'}));
  const job=(run,id,name,names)=>({id,name,run_id:run.id,run_attempt:1,
    status:'completed',conclusion:'success',steps:steps(names)});
  original.publisherJobs={jobs:[
    job(original.publisher,1,'verify',['Verify only authenticated owner/main requests and valid inert data']),
    job(original.publisher,2,'publish',[
      'Reverify source and effective GitHub protection before App token',
      'Mint dedicated Knowledge App token only after admission',
      'Publish one non-force validated fast-forward and verify GitHub SHA',
      'Preserve bounded sanitized publication evidence'])]};
  original.signalJobs={jobs:[job(original.signal,3,'signal',['Record Knowledge revision'])]};
  original.pagesJobs={jobs:[
    job(original.pages,4,'Build independent Pages',[
      'Validate Knowledge ledger at pinned checkout','Validate independent public projection',
      'Capture exact static public evidence digest and coverage','Upload standalone Pages']),
    job(original.pages,5,'Publish independent Pages',[
      'Deploy GitHub Pages','Verify public site URL and exact deployed main SHA'])]};
  const receipt={
    schema_version:1,event:'issue_comment',source_run_id:null,source_comment_id:p.comment,
    source_ref:'refs/heads/knowledge-proposals/proof',
    source_sha:published,expected_head:base,trusted_main_sha:main,
    run_id:String(p.publisher),run_attempt:'1',status:'validated_no_write'};
  original.verifyLog='2026-11-10T10:01:02.000Z '+JSON.stringify(receipt)+'\n';
  original.publishLog=original.verifyLog+
    '2026-11-10T10:01:03.000Z '+JSON.stringify({writer_ruleset_id:26835890,
      append_only_ruleset_id:26836090,app_id:5677350,
      result:'active_ruleset_structure_verified_readonly'})+'\n';
  original.pagesLog='2026-11-10T10:04:00.000Z Public Knowledge verified: source='+
    published+' articles=21 digest='+digest+'\n';
  const prove=x=>attestKnowledgePublication({...original,...x});
  assert.equal(prove({}).published_knowledge_sha,published);
  assert.equal(prove({}).establishes_sc_verdict,false);
  assert.equal(shouldCollectKnowledgePublication('pre-merge',3156),false);
  assert.equal(shouldCollectKnowledgePublication('post-merge',3224),true);
  const bad=[
    {comment:{...original.comment,author_association:'MEMBER'}},
    {comment:{...original.comment,updated_at:'2026-11-10T10:00:01Z'}},
    {publisher:{...original.publisher,actor:{login:'attacker'}}},
    {publisher:{...original.publisher,head_sha:head}},
    {publisher:{...original.publisher,run_attempt:2}},
    {publisher:{...original.publisher,conclusion:'skipped'}},
    {proposalCommit:{sha:published,parents:[{sha:head}]}},
    {proposalCommit:{sha:published,parents:[{sha:base},{sha:head}]}},
    {signal:{...original.signal,actor:{login:'untrusted[bot]'}}},
    {pages:{...original.pages,event:'push'}},
    {pages:{...original.pages,conclusion:'failure'}},
    {pagesLog:original.pagesLog.replace('source='+published,'source='+head)},
    {pagesLog:original.pagesLog.replace('digest='+digest,'digest=bad')},
    {pagesLog:original.pagesLog+original.pagesLog},
    {verifyLog:original.verifyLog.replace('"source_comment_id":'+p.comment,'"source_comment_id":123')},
    {publishLog:original.publishLog.replace('"app_id":5677350','"app_id":1')},
    {implementedToPublisher:{merge_base_commit:{sha:head},base_commit:{sha:IMPLEMENTED},status:'ahead'}},
    {implementedToTarget:{merge_base_commit:{sha:head},base_commit:{sha:IMPLEMENTED},status:'ahead'}},
    {targetToPublisher:{merge_base_commit:{sha:head},base_commit:{sha:IMPLEMENTED},status:'ahead'}},
  ];
  for(const patch of bad)assert.throws(()=>prove(patch));
  for(const name of ['verify','publish']){
    const jobs=original.publisherJobs.jobs.map(j=>j.name===name?
      {...j,steps:[{name:'skipped',status:'completed',conclusion:'success'}]}:j);
    assert.throws(()=>prove({publisherJobs:{jobs}}));
  }
  return true;
}
if(process.argv[2]==='self-test'){
  selfTestKnowledgePublication();
  console.log('knowledge acceptance: protected owner Publisher/Pages positive and negative fixtures passed');
}
