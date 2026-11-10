// #3145: bounded, immutable-source attestation of the repaired Knowledge
// proposal reaching a protected HEAD and the exact Sandbox HTML public Pages
// deployment. This collector is READ ONLY; only the canonical SC updater may
// produce a verdict. The successor Publisher does NOT retroactively prove
// which credential wrote the preceding correction commit.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {attestPagesDeployment} from './acceptance-pages-deployment-receipt.mjs';
import {mainAncestry} from './acceptance-knowledge-publisher-evidence.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/, DIGEST=/^[a-f0-9]{64}$/;
const MAIN_FIX='d840178d187d88d3c7abf9107855f66a16e4bec1';
const PAGES_MAIN='f5c0be9df48300c483928e10841b0654ac83e905';
const PREVIOUS='6d0f1ad0425427ad5e03310cadb9ff234bf2f4aa';
const REPAIR='70daec2acab7df5334e91840c1870a03d5b04992';
const NEXT='9b9a69beb5e02f3f6fb9448fce6f6ec431c21f8b';
const KNOWLEDGE='336fa2977ec636f5e5291f3863b7fb07bdf2f94a';
const PROTOTYPE='fc09bf0613adfd0b451ff28c292311b0e6f4292c';
const ORIGINAL_PROTOTYPE='4c5470f7f9a7aa47965fd93a7f6c1d482b72160f';
const COMMENT=6761534336, PUBLISHER=42774755534, PAGES=42863659044;
const SANDBOX='sandbox-capability-3124/index.html';
const ROOT='https://bestnathan.github.io/nession/prototypes/';
const FILES=[
  'CHANGELOG.md','index.json',
  'topics/engineering/nession-sandbox-policy-and-execution-isolation-architecture.md'
].sort();
const positive=n=>Number.isSafeInteger(n)&&n>0;
const deny=(ok,why)=>{if(!ok)throw Error('knowledge sandbox #3145: '+why);};

export function shouldCollectSandbox3145(stage,issue){
  return stage==='post-merge' && String(issue)==='3145';
}
function marker(log,pattern,why){
  deny(typeof log==='string'&&log.length<1024*1024,'unbounded '+why+' log');
  const found=log.split(/\r?\n/).map(x=>x.match(pattern)).filter(Boolean);
  deny(found.length===1,'missing/ambiguous '+why+' receipt');
  return found[0];
}
function job(jobs,run,name,steps){
  deny(Array.isArray(jobs?.jobs)&&jobs.jobs.length<=35,'unbounded jobs');
  const found=jobs.jobs.filter(j=>j.name===name&&
    j.run_id===run.id&&(j.run_attempt==null||j.run_attempt===run.run_attempt)&&
    j.status==='completed'&&j.conclusion==='success');
  deny(found.length===1&&positive(found[0].id),'missing exact '+name+' job');
  for(const step of steps)deny(found[0].steps?.some(s=>
    s.name===step&&s.conclusion==='success'),'missing trusted '+step+' step');
  return found[0].id;
}
function admission(log,run){
  const match=marker(log,/^\d{4}-\d\d-\d\dT\S+Z (\{"schema_version":1,"event":"issue_comment".*\})$/,'Publisher admission');
  let data;
  try{data=JSON.parse(match[1]);}catch{throw Error('bad Publisher receipt JSON');}
  deny(data.schema_version===1&&data.event==='issue_comment'&&
    data.source_comment_id===COMMENT&&
    data.source_ref==='refs/heads/knowledge-proposals/owner-comment-3156'&&
    data.source_sha===NEXT&&data.expected_head===REPAIR&&
    data.trusted_main_sha===run.head_sha&&data.run_id===String(run.id)&&
    data.run_attempt===String(run.run_attempt)&&
    data.status==='validated_no_write','Publisher admission content mismatch');
}
function policy(log){
  const match=marker(log,/^\d{4}-\d\d-\d\dT\S+Z (\{.*"result":"active_ruleset_structure_verified_readonly"\})$/,'Writer policy');
  const o=JSON.parse(match[1]);
  deny(o.knowledge_head===REPAIR&&o.app_id===5677350&&
    o.writer_ruleset_id===26835890&&o.append_only_ruleset_id===26836090&&
    o.result==='active_ruleset_structure_verified_readonly',
    'protected predecessor / writer App / ruleset mismatch');
}
function publicReceipt(log){
  const sandbox=marker(log,/^\d{4}-\d\d-\d\dT\S+Z Public Sandbox prototype verified: source=([a-f0-9]{40}) html_sha256=([a-f0-9]{64})$/,'Sandbox HTML');
  const knowledge=marker(log,/^\d{4}-\d\d-\d\dT\S+Z Public Knowledge verified: source=([a-f0-9]{40}) articles=(\d+) digest=([a-f0-9]{64})$/,'Knowledge public');
  const protoEnv=marker(log,/^\d{4}-\d\d-\d\dT\S+Z   EXPECTED_PROTO_SHA: ([a-f0-9]{40})$/,'Prototype environment');
  const knowledgeEnv=marker(log,/^\d{4}-\d\d-\d\dT\S+Z   EXPECTED_KNOWLEDGE_SHA: ([a-f0-9]{40})$/,'Knowledge environment');
  deny(sandbox[1]===PROTOTYPE&&protoEnv[1]===PROTOTYPE&&
    knowledge[1]===KNOWLEDGE&&knowledgeEnv[1]===KNOWLEDGE&&
    Number(knowledge[2])>=19&&DIGEST.test(knowledge[3]),'public source SHA drift');
  return {sandboxDigest:sandbox[2],knowledgeDigest:knowledge[3],articles:Number(knowledge[2])};
}
export function attestSandbox3145({
  targetSha,correction,ownerComment,publisher,publisherJobs,
  publisherVerifyLog,publisherPublishLog,pages,pagesJobs,pagesLog,
  correctedToPublished,originalToPrototype,fixToPublisher,pagesToTarget,
  manifestBytes,sandboxBytes,
}){
  deny(SHA.test(targetSha),'invalid target SHA');
  deny(correction?.sha===REPAIR&&correction.parents?.length===1&&
    correction.parents[0].sha===PREVIOUS&&
    Array.isArray(correction.files)&&correction.files.length===3&&
    JSON.stringify(correction.files.map(x=>x.filename).sort())===JSON.stringify(FILES),
    'correction not a one-commit article/index/Changelog change');
  deny(correctedToPublished?.base_commit?.sha===REPAIR&&
    correctedToPublished?.merge_base_commit?.sha===REPAIR&&
    ['ahead','identical'].includes(correctedToPublished?.status),
    'published Knowledge does not descend from repaired source');
  deny(originalToPrototype?.base_commit?.sha===ORIGINAL_PROTOTYPE&&
    originalToPrototype?.merge_base_commit?.sha===ORIGINAL_PROTOTYPE&&
    ['ahead','identical'].includes(originalToPrototype?.status),
    'published prototype not descended from original Sandbox source');
  deny(ownerComment?.id===COMMENT&&ownerComment.user?.login==='BestNathan'&&
    ownerComment.author_association==='OWNER'&&
    ownerComment.issue_url==='https://api.github.com/repos/'+REPO+'/issues/3156'&&
    ownerComment.created_at===ownerComment.updated_at&&
    ownerComment.body?.trim()==='/knowledge-publish v1\n'+
       'proposal_ref=refs/heads/knowledge-proposals/owner-comment-3156\n'+
       'proposal_sha='+NEXT+'\nexpected_head='+REPAIR,
    'untrusted successor Owner authorization');
  deny(publisher?.id===PUBLISHER&&publisher.run_attempt===1&&
    publisher.name==='Store / Knowledge Publisher'&&
    publisher.path==='.github/workflows/store-knowledge-publisher.yml'&&
    publisher.event==='issue_comment'&&publisher.head_branch==='main'&&
    publisher.actor?.login==='BestNathan'&&
    publisher.repository?.full_name===REPO&&publisher.head_repository?.full_name===REPO&&
    publisher.status==='completed'&&publisher.conclusion==='success'&&
    mainAncestry(fixToPublisher,MAIN_FIX,publisher.head_sha),
    'untrusted main-owned successor Publisher');
  const verifyId=job(publisherJobs,publisher,'verify',
    ['Verify only authenticated owner/main requests and valid inert data']);
  const publishId=job(publisherJobs,publisher,'publish',[
    'Reverify source and effective GitHub protection before App token',
    'Mint dedicated Knowledge App token only after admission',
    'Publish one non-force validated fast-forward and verify GitHub SHA',
  ]);
  admission(publisherVerifyLog,publisher);
  admission(publisherPublishLog,publisher);
  policy(publisherPublishLog);
  // SC-02 still requires the ORIGINAL REPAIR's authenticated App publish
  // attempt; a successor App's checked predecessor is not that receipt.
  deny(mainAncestry(pagesToTarget,PAGES_MAIN,targetSha),
    'target does not descend from verified Sandbox Pages main');
  deny(pages?.id===PAGES&&pages?.run_attempt===1,
    'untrusted Sandbox Pages Run/Attempt');
  const proven=attestPagesDeployment(REPO,PAGES_MAIN,pages,pagesJobs,pagesLog);
  const pub=publicReceipt(pagesLog);
  deny(Buffer.isBuffer(manifestBytes)&&manifestBytes.length>2&&manifestBytes.length<1024*1024,
    'invalid bounded public manifest');
  deny(Buffer.isBuffer(sandboxBytes)&&sandboxBytes.length>2&&sandboxBytes.length<2*1024*1024,
    'invalid bounded public Sandbox HTML');
  let manifest;
  try{manifest=JSON.parse(manifestBytes.toString('utf8'));}catch{throw Error('invalid public prototype manifest');}
  const expectedSource='https://github.com/'+REPO+'/blob/'+PROTOTYPE+'/'+SANDBOX;
  deny(manifest.schema_version===1&&manifest.source?.branch==='prototype'&&
    manifest.source.sha===PROTOTYPE&&
    manifest.entries?.filter(x=>x.slug==='sandbox-capability-3124'&&
      x.preview==='prototypes/'+SANDBOX&&x.source===expectedSource).length===1,
    'public manifest/Sandbox source mismatch');
  const digest=createHash('sha256').update(sandboxBytes).digest('hex');
  deny(digest===pub.sandboxDigest&&
    sandboxBytes.toString('utf8').includes(expectedSource),
    'anonymous Sandbox HTML does not match publisher SHA256/source');
  return Object.freeze({
    kind:'verified_knowledge_sandbox_pages_3145',schema_version:1,
    acceptance_target_sha:targetSha,correction_sha:REPAIR,
    preceding_protected_knowledge_sha:REPAIR,
    successor_publisher_run_id:PUBLISHER,
    successor_publisher_verify_job_id:verifyId,
    successor_protected_app_job_id:publishId,
    published_knowledge_sha:KNOWLEDGE,public_knowledge_articles:pub.articles,
    public_knowledge_sha256:pub.knowledgeDigest,
    prototype_sha:PROTOTYPE,
    pages_main_sha:PAGES_MAIN,pages_run_id:PAGES,pages_run_attempt:pages.run_attempt,
    pages_build_job_id:proven.build_job_id,pages_publish_job_id:proven.publish_job_id,
    public_sandbox_html_sha256:digest,public_sandbox_url:ROOT+SANDBOX,
    public_manifest_url:ROOT+'manifest.json',
    verified_by:'native GitHub REST exact Run/Attempt/Jobs, protected successor admission/policy, immutable ancestry and anonymous HTTPS manifest+Sandbox HTML bytes',
    original_repair_publisher_receipt:false,
    establishes_sc_verdict:false,
  });
}
async function getPublic(url,max) {
  const response=await fetch(url+'?revision='+PROTOTYPE,{
    redirect:'error',cache:'no-store',credentials:'omit',
    headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)
  });
  deny(response.ok&&response.url===url+'?revision='+PROTOTYPE&&response.body,
    'anonymous HTTPS unavailable');
  const chunks=[];let total=0;
  for await(const chunk of response.body){
    total+=chunk.byteLength;deny(total<=max,'public response too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function collectSandbox3145({repo,targetSha,stage,issue,get,getLog,readPublic=getPublic}){
  if(!shouldCollectSandbox3145(stage,issue))return [];
  deny(repo===REPO&&SHA.test(targetSha),'invalid evidence scope');
  const api='/repos/'+REPO;
  const [correction,ownerComment,publisher,pages,correctedToPublished,originalToPrototype,pagesToTarget]=await Promise.all([
    get(api+'/commits/'+REPAIR),get(api+'/issues/comments/'+COMMENT),
    get(api+'/actions/runs/'+PUBLISHER),get(api+'/actions/runs/'+PAGES),
    get(api+'/compare/'+REPAIR+'...'+KNOWLEDGE),
    get(api+'/compare/'+ORIGINAL_PROTOTYPE+'...'+PROTOTYPE),
    get(api+'/compare/'+PAGES_MAIN+'...'+targetSha)
  ]);
  const [publisherJobs,pagesJobs,fixToPublisher]=await Promise.all([
    get(api+'/actions/runs/'+PUBLISHER+'/attempts/'+publisher.run_attempt+'/jobs?per_page=100'),
    get(api+'/actions/runs/'+PAGES+'/attempts/'+pages.run_attempt+'/jobs?per_page=100'),
    get(api+'/compare/'+MAIN_FIX+'...'+publisher.head_sha),
  ]);
  const pick=(jobs,name)=>{const arr=jobs.jobs?.filter(j=>j.name===name);
    deny(arr?.length===1&&positive(arr[0].id),'missing exact '+name+' producer');
    return arr[0].id;};
  const [publisherVerifyLog,publisherPublishLog,pagesLog,manifestBytes,sandboxBytes]=await Promise.all([
    getLog(api+'/actions/jobs/'+pick(publisherJobs,'verify')+'/logs'),
    getLog(api+'/actions/jobs/'+pick(publisherJobs,'publish')+'/logs'),
    getLog(api+'/actions/jobs/'+pick(pagesJobs,'Publish independent Pages')+'/logs'),
    readPublic(ROOT+'manifest.json',1024*1024),
    readPublic(ROOT+SANDBOX,2*1024*1024),
  ]);
  return [attestSandbox3145({targetSha,correction,ownerComment,publisher,publisherJobs,
    publisherVerifyLog,publisherPublishLog,pages,pagesJobs,pagesLog,
    correctedToPublished,originalToPrototype,fixToPublisher,pagesToTarget,
    manifestBytes,sandboxBytes})];
}
export function selfTestSandbox3145(){
  assert.equal(shouldCollectSandbox3145('post-merge',3145),true);
  assert.equal(shouldCollectSandbox3145('pre-merge',3145),false);
  assert.equal(shouldCollectSandbox3145('post-merge',3156),false);
  const target='a'.repeat(40);
  const markerLine=s=>'2026-11-10T17:22:00.000Z '+s+'\n';
  const publisher={id:PUBLISHER,run_attempt:1,name:'Store / Knowledge Publisher',
    path:'.github/workflows/store-knowledge-publisher.yml',
    event:'issue_comment',head_branch:'main',head_sha:MAIN_FIX,actor:{login:'BestNathan'},
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion:'success'};
  const jobs=(run,values)=>({jobs:values.map(([id,name,names])=>({
    id,name,run_id:run.id,run_attempt:run.run_attempt,head_sha:run.head_sha,
    status:'completed',conclusion:'success',
    steps:names.map(name=>({name,conclusion:'success'}))
  }))});
  const publisherJobs=jobs(publisher,[
    [1,'verify',['Verify only authenticated owner/main requests and valid inert data']],
    [2,'publish',['Reverify source and effective GitHub protection before App token',
      'Mint dedicated Knowledge App token only after admission',
      'Publish one non-force validated fast-forward and verify GitHub SHA']]
  ]);
  const pages={id:PAGES,run_attempt:1,name:'Deploy / Public Pages',
    path:'.github/workflows/deploy-pages.yml',event:'push',head_branch:'main',
    head_sha:PAGES_MAIN,repository:{full_name:REPO},head_repository:{full_name:REPO},
    status:'completed',conclusion:'success'};
  const pagesJobs=jobs(pages,[
    [3,'Build independent Pages',['Capture exact static public evidence digest and coverage','Upload standalone Pages']],
    [4,'Publish independent Pages',['Verify public site URL and exact deployed main SHA','Deploy GitHub Pages']]
  ]);
  const admission=markerLine(JSON.stringify({
    schema_version:1,event:'issue_comment',source_comment_id:COMMENT,
    source_ref:'refs/heads/knowledge-proposals/owner-comment-3156',
    source_sha:NEXT,expected_head:REPAIR,trusted_main_sha:MAIN_FIX,
    run_id:String(PUBLISHER),run_attempt:'1',status:'validated_no_write'
  }));
  const publishLog=admission+markerLine(JSON.stringify({
    knowledge_head:REPAIR,app_id:5677350,
    writer_ruleset_id:26835890,append_only_ruleset_id:26836090,
    result:'active_ruleset_structure_verified_readonly'
  }));
  const expectedSource='https://github.com/'+REPO+'/blob/'+PROTOTYPE+'/'+SANDBOX;
  const sandboxBytes=Buffer.from('<html><head></head><body><a href="'+expectedSource+'">View source</a></body></html>');
  const digest=createHash('sha256').update(sandboxBytes).digest('hex');
  const manifestBytes=Buffer.from(JSON.stringify({
    schema_version:1,source:{branch:'prototype',sha:PROTOTYPE},
    entries:[{slug:'sandbox-capability-3124',preview:'prototypes/'+SANDBOX,source:expectedSource}]
  }));
  const pagesLog=markerLine('Public Issue Agent Run observation: source_backed_observation (source=available, runs=8, digest='+'b'.repeat(64)+')')+
    markerLine('  EXPECTED_PROTO_SHA: '+PROTOTYPE)+
    markerLine('  EXPECTED_KNOWLEDGE_SHA: '+KNOWLEDGE)+
    markerLine('Public Knowledge verified: source='+KNOWLEDGE+' articles=21 digest='+'c'.repeat(64))+
    markerLine('Public Sandbox prototype verified: source='+PROTOTYPE+' html_sha256='+digest);
  const ancestry=(base)=>({base_commit:{sha:base},merge_base_commit:{sha:base},status:'ahead'});
  const valid={targetSha:target,correction:{sha:REPAIR,parents:[{sha:PREVIOUS}],
    files:FILES.map(filename=>({filename}))},
    ownerComment:{id:COMMENT,user:{login:'BestNathan'},author_association:'OWNER',
      issue_url:'https://api.github.com/repos/'+REPO+'/issues/3156',
      created_at:'2026-11-10T07:20:00Z',updated_at:'2026-11-10T07:20:00Z',
      body:'/knowledge-publish v1\nproposal_ref=refs/heads/knowledge-proposals/owner-comment-3156\nproposal_sha='+NEXT+'\nexpected_head='+REPAIR},
    publisher,publisherJobs,publisherVerifyLog:admission,publisherPublishLog:publishLog,
    pages,pagesJobs,pagesLog,correctedToPublished:ancestry(REPAIR),
    originalToPrototype:ancestry(ORIGINAL_PROTOTYPE),
    fixToPublisher:ancestry(MAIN_FIX),pagesToTarget:ancestry(PAGES_MAIN),
    manifestBytes,sandboxBytes};
  const ok=attestSandbox3145(valid);
  assert.equal(ok.public_sandbox_html_sha256,digest);
  assert.equal(ok.original_repair_publisher_receipt,false);
  assert.equal(ok.establishes_sc_verdict,false);
  for(const variant of [
    {correction:{...valid.correction,parents:[{sha:'f'.repeat(40)}]}},
    {correction:{...valid.correction,files:valid.correction.files.slice(1)}},
    {ownerComment:{...valid.ownerComment,user:{login:'other'}}},
    {publisher:{...publisher,event:'pull_request'}},
    {publisher:{...publisher,head_sha:'e'.repeat(40)}},
    {publisherJobs:{jobs:publisherJobs.jobs.slice(1)}},
    {publisherPublishLog:publishLog.replace('"knowledge_head":"'+REPAIR+'"','"knowledge_head":"'+PREVIOUS+'"')},
    {publisherPublishLog:publishLog.replace('"app_id":5677350','"app_id":0')},
    {publisherVerifyLog:admission.replace('"expected_head":"'+REPAIR+'"','"expected_head":"'+PREVIOUS+'"')},
    {pages:{...pages,run_attempt:2}},
    {pages:{...pages,conclusion:'failure'}},
    {pagesToTarget:{base_commit:{sha:PAGES_MAIN},merge_base_commit:{sha:'d'.repeat(40)},status:'diverged'}},
    {pagesLog:pagesLog.replace('source='+PROTOTYPE,'source='+'f'.repeat(40))},
    {pagesLog:pagesLog+pagesLog},
    {sandboxBytes:Buffer.concat([sandboxBytes,Buffer.from('tampered')])},
    {manifestBytes:Buffer.from('{"entries":[]}')},
    {correctedToPublished:{...ancestry(REPAIR),merge_base_commit:{sha:'d'.repeat(40)}}}
  ])assert.throws(()=>attestSandbox3145({...valid,...variant}));
  return true;
}
if(process.argv[2]==='self-test'){
  selfTestSandbox3145();
  console.log('knowledge sandbox #3145: protected predecessor, exact Pages SHA/HTML, negative evidence fixtures passed');
}
