// #4160: bounded, read-only, source-verified historic GHCR/Pages acceptance.
// This collector never dispatches, publishes, checks out untrusted code, or
// reads arbitrary Issue-selected Run IDs. Immutable IDs are discovery pins;
// each REST Run/Attempt/Job/log/ref is independently attested.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession';
const PREFIX='/repos/'+REPO;
const SHA=/^[0-9a-f]{40}$/;
const FIRST_MAIN='b9e9886714ad1f4f78ec87897c30ccb6c9c84c64';
const DOCUMENTED_MAIN='e1f4b9a39cf7c67499a647bde08af9082b2a9f56';
const KNOWLEDGE_SHA='b74b8457cfc0232fa2bc982f813a3e59f8cf60bb';
const KNOWLEDGE_PARENT='2fccee52ef60b0d0a3114edae5b8c7c885f19b34';
const KNOWLEDGE_DIGEST='fb8de36e4dd4917eebe24ba4087d514dcb4a175557d160dcc073738f2f94eea2';
const CATALOG_FIRST='82881f5333d4bff1091beee8ce4e6d270aeead60';
const CATALOG_REPLAY='72e1e80b7a7a54b660287f2496114760bbf88bdc';
export const PINS=Object.freeze({
  firstSignal:44721545621,firstRelease:44721571308,
  replaySignal:44723056499,replayRelease:44723079703,
  knowledgeComment:7037814337,knowledgePublisher:44723825048,
  knowledgeSignal:44723929120,pages:44723952582,
});
const VERSION_DIGEST=Object.freeze({
  'gh-2.105.0':'2bd0fe388655d48fd514431095bc52bfb1d319fedc4fd183feb5949e4fb73587',
  'jq-1.7.1':'87d7f39a64ac5864515d312d8175fdc851940335ae46ab899c8a722c3e1d01a7',
  'jq-1.8.1':'8cb5abadfafe287b41700c0624fa93241dbc0e77373894d1875d32f6059dd7df',
  'kubectl-1.35.0':'704c2e6c12f6b404ae76977757272d9bed3473b4e4b95daeedef28822f0ad650',
});
const PLATFORM_SET=Object.freeze({
  'gh-2.105.0':['linux, amd64, linux-amd64','linux, arm64, linux-arm64'],
  'jq-1.7.1':['linux, amd64, linux-amd64'],
  'jq-1.8.1':['linux, amd64, linux-amd64','linux, arm64, linux-arm64'],
  'kubectl-1.35.0':['linux, amd64, linux-amd64'],
});
const NAME_BY_VERSION=Object.freeze({
  'gh-2.105.0':'gh, 2.105.0','jq-1.7.1':'jq, 1.7.1',
  'jq-1.8.1':'jq, 1.8.1','kubectl-1.35.0':'kubectl, 1.35.0',
});
function deny(ok,detail){if(!ok)throw Error('toolchain #4160 acceptance: '+detail);}
function equalShaAncestry(compare,anchor,target){
  return anchor===target||(compare?.base_commit?.sha===anchor&&
    compare?.merge_base_commit?.sha===anchor&&
    ['ahead','identical'].includes(compare.status));
}
function verifyRun(run,{id,name,path,event,branch,sha}){
  deny(run?.id===id&&run.run_attempt===1&&
    run.name===name&&run.path===path&&run.event===event&&
    run.head_branch===branch&&run.head_sha===sha&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.status==='completed'&&run.conclusion==='success',
    'untrusted '+name+' run/attempt/ref '+id);
}
function checkedJob(response,run,name,outcome='success'){
  deny(Array.isArray(response?.jobs)&&response.jobs.length<=100,'invalid job collection');
  const found=response.jobs.filter(j=>j?.name===name);
  deny(found.length===1,'missing/ambiguous job '+name);
  const job=found[0];
  deny(Number.isSafeInteger(job.id)&&job.run_id===run.id&&
    (job.run_attempt==null||job.run_attempt===run.run_attempt)&&
    job.status==='completed'&&job.conclusion===outcome,
    'unexpected job outcome '+name);
  return job;
}
function attestPublisherLog(log,tool){
  const digest=VERSION_DIGEST[tool],ref='ghcr.io/bestnathan/nession-toolchain:'+tool;
  deny(typeof log==='string'&&log.length<1048576,'publisher log too large');
  const expected='Complete Toolchain OCI Index '+ref+'@sha256:'+digest;
  deny(log.includes(expected)&&/GHCR publish: uploaded=\d+ reused=\d+ manifests=\d+/.test(log),
    'publisher missing exact OCI Index and CAS receipt '+tool);
  return {tag:ref,immutable_digest:'sha256:'+digest};
}
function attestReadbackLog(log,tool){
  const ref='ghcr.io/bestnathan/nession-toolchain:'+tool,digest=VERSION_DIGEST[tool];
  deny(typeof log==='string'&&log.length<1048576,'readback log too large');
  deny(log.includes('Independent OCI Index/Manifest/Config/EROFS readback PASS: '+ref+'@sha256:'+digest),
    'missing exact remote Index/Config/EROFS readback '+tool);
}
function attestKnowledge({comment,commit,ref,publication,pagesLog}){
  deny(comment?.id===PINS.knowledgeComment&&comment.user?.login==='BestNathan'&&
    comment.issue_url===PREFIX.replace('/repos/','https://api.github.com/repos/')+'/issues/4160'&&
    comment.body===
      '/knowledge-publish v1\n'+
      'proposal_ref=refs/heads/knowledge-proposals/toolchain-4160-oci-release\n'+
      'proposal_sha='+KNOWLEDGE_SHA+'\n'+
      'expected_head='+KNOWLEDGE_PARENT,
    'Knowledge publisher owner source comment differs');
  deny(commit?.sha===KNOWLEDGE_SHA&&commit.parents?.length===1&&
    commit.parents[0]?.sha===KNOWLEDGE_PARENT&&
    commit.files?.length===3,
    'protected Knowledge commit parent or changed-file count differs');
  const expected=new Set(['CHANGELOG.md','index.json',
    'topics/workflows/nession-native-toolchain-oci-release-to-ghcr.md']);
  for(const f of commit.files)deny(expected.delete(f.filename)&&f.status==='modified','unexpected Knowledge path');
  deny(!expected.size,'missing Knowledge update path');
  deny(ref?.ref==='refs/heads/knowledge'&&SHA.test(ref.object?.sha),
    'Knowledge protected ref invalid');
  deny(publication.verify&&publication.publish,'Knowledge Publisher verify/publish absent');
  deny(typeof pagesLog==='string'&&pagesLog.length<1048576&&
    pagesLog.includes('Public Knowledge verified: source='+KNOWLEDGE_SHA+
      ' articles=28 digest='+KNOWLEDGE_DIGEST),
    'missing public anonymous HTTPS exact Knowledge readback');
  return {source_sha:KNOWLEDGE_SHA,public_json_sha256:KNOWLEDGE_DIGEST,
    articles:28,comment:PINS.knowledgeComment,publisher:PINS.knowledgePublisher,
    pages:PINS.pages,live_head:ref.object.sha};
}
export function shouldCollectToolchain4160(stage,issue){
  return stage==='post-merge'&&String(issue)==='4160';
}
export async function collectToolchain4160({repo,targetSha,stage,issue,get,getLog}){
  deny(repo===REPO&&shouldCollectToolchain4160(stage,issue)&&SHA.test(targetSha),
    'wrong Issue, stage or target');
  const ancestor=targetSha===DOCUMENTED_MAIN?null:
    await get(PREFIX+'/compare/'+DOCUMENTED_MAIN+'...'+targetSha);
  deny(equalShaAncestry(ancestor,DOCUMENTED_MAIN,targetSha),
    'target does not descend from documented implementation and Publisher main SHA');
  const specs=[
    {id:PINS.firstSignal,name:'Toolchains / Catalog Change',
      path:'.github/workflows/toolchain-changed.yml',event:'push',
      branch:'toolchains',sha:CATALOG_FIRST},
    {id:PINS.firstRelease,name:'Release / Toolchains',
      path:'.github/workflows/release-toolchains.yml',event:'workflow_run',
      branch:'main',sha:FIRST_MAIN},
    {id:PINS.replaySignal,name:'Toolchains / Catalog Change',
      path:'.github/workflows/toolchain-changed.yml',event:'push',
      branch:'toolchains',sha:CATALOG_REPLAY},
    {id:PINS.replayRelease,name:'Release / Toolchains',
      path:'.github/workflows/release-toolchains.yml',event:'workflow_run',
      branch:'main',sha:FIRST_MAIN},
    {id:PINS.knowledgePublisher,name:'Store / Knowledge Publisher',
      path:'.github/workflows/store-knowledge-publisher.yml',
      event:'issue_comment',branch:'main',sha:DOCUMENTED_MAIN},
    {id:PINS.knowledgeSignal,name:'Knowledge / Change Signal',
      path:'.github/workflows/knowledge-changed.yml',event:'push',
      branch:'knowledge',sha:KNOWLEDGE_SHA},
    {id:PINS.pages,name:'Deploy / Public Pages',
      path:'.github/workflows/deploy-pages.yml',event:'workflow_run',
      branch:'main',sha:DOCUMENTED_MAIN},
  ];
  const runs=new Map();
  for(const spec of specs){
    const run=await get(PREFIX+'/actions/runs/'+spec.id);
    verifyRun(run,spec);
    runs.set(spec.id,run);
  }
  const jobs=new Map();
  for(const id of [PINS.firstRelease,PINS.replayRelease,PINS.knowledgePublisher,PINS.pages]){
    const run=runs.get(id);
    const data=await get(PREFIX+'/actions/runs/'+id+'/attempts/'+run.run_attempt+'/jobs?per_page=100');
    deny(Array.isArray(data?.jobs)&&data.jobs.length<=100,'unbounded job readback');
    jobs.set(id,data);
  }
  const published=[];
  const first=runs.get(PINS.firstRelease),fj=jobs.get(PINS.firstRelease);
  checkedJob(fj,first,'plan');
  for(const [tool,name] of Object.entries(NAME_BY_VERSION)){
    checkedJob(fj,first,'release ('+name+') / targets');
    checkedJob(fj,first,'release ('+name+') / probe');
    for(const target of PLATFORM_SET[tool]){
      checkedJob(fj,first,'release ('+name+') / prepare ('+target+')');
      checkedJob(fj,first,'release ('+name+') / verify ('+target+')');
    }
    const publish=checkedJob(fj,first,'release ('+name+') / publish');
    const readback=checkedJob(fj,first,'release ('+name+') / readback');
    const [publishLog,readbackLog]=await Promise.all([
      getLog(PREFIX+'/actions/jobs/'+publish.id+'/logs'),
      getLog(PREFIX+'/actions/jobs/'+readback.id+'/logs')]);
    const record=attestPublisherLog(publishLog,tool);
    attestReadbackLog(readbackLog,tool);
    published.push({...record,platforms:PLATFORM_SET[tool].map(x=>x.replace(/, /g,'/').split('/').slice(0,2).join('/')),
      publish_job:publish.id,readback_job:readback.id});
  }
  const skip=runs.get(PINS.replayRelease),sj=jobs.get(PINS.replayRelease);
  checkedJob(sj,skip,'plan');
  for(const name of Object.values(NAME_BY_VERSION)){
    checkedJob(sj,skip,'release ('+name+') / targets');
    checkedJob(sj,skip,'release ('+name+') / probe');
    for(const kind of ['prepare','publish','readback','verify'])
      checkedJob(sj,skip,'release ('+name+') / '+kind,'skipped');
  }
  const publisher=runs.get(PINS.knowledgePublisher),pj=jobs.get(PINS.knowledgePublisher);
  const verify=checkedJob(pj,publisher,'verify'),publishedKnowledge=checkedJob(pj,publisher,'publish');
  const pages=runs.get(PINS.pages),pageJobs=jobs.get(PINS.pages);
  const pagesJob=checkedJob(pageJobs,pages,'Publish independent Pages');
  checkedJob(pageJobs,pages,'Build independent Pages');
  const [comment,commit,ref,pagesLog]=await Promise.all([
    get(PREFIX+'/issues/comments/'+PINS.knowledgeComment),
    get(PREFIX+'/commits/'+KNOWLEDGE_SHA),
    get(PREFIX+'/git/ref/heads/knowledge'),
    getLog(PREFIX+'/actions/jobs/'+pagesJob.id+'/logs')]);
  const knowledge=attestKnowledge({comment,commit,ref,
    publication:{verify:verify.id,publish:publishedKnowledge.id},pagesLog});
  if(ref.object.sha!==KNOWLEDGE_SHA){
    const lineage=await get(PREFIX+'/compare/'+KNOWLEDGE_SHA+'...'+ref.object.sha);
    deny(equalShaAncestry(lineage,KNOWLEDGE_SHA,ref.object.sha),
      'live protected Knowledge is not published descendant');
  }
  return {
    kind:'verified_toolchain_4160_readonly',
    target_sha:targetSha,source_signal:PINS.firstSignal,
    original_release:{run:PINS.firstRelease,attempt:first.run_attempt,source_sha:CATALOG_FIRST,
      main_sha:FIRST_MAIN,published},
    unchanged_fingerprint_reuse:{run:PINS.replayRelease,attempt:skip.run_attempt,
      source_sha:CATALOG_REPLAY,all_four_skipped:true},
    protected_knowledge:knowledge,
    // First live release was catalog README-only; do not misstate it as
    // per-version changed-only routing proof. Later independent changed-script
    // source must be authenticated before SC-03 can be claimed.
    changed_script_impact_evidence:null,
  };
}
export function selfTestToolchain4160(){
  const base={id:1,run_attempt:1,name:'Release / Toolchains',
    path:'.github/workflows/release-toolchains.yml',event:'workflow_run',
    head_branch:'main',head_sha:FIRST_MAIN,status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const spec={id:1,name:base.name,path:base.path,event:base.event,
    branch:base.head_branch,sha:base.head_sha};
  verifyRun(base,spec);
  assert.throws(()=>verifyRun({...base,head_branch:'toolchains'},spec),/untrusted/);
  assert.throws(()=>verifyRun({...base,run_attempt:0},spec),/untrusted/);
  assert.throws(()=>verifyRun({...base,conclusion:'failure'},spec),/untrusted/);
  const job={id:4,run_id:1,status:'completed',conclusion:'success',name:'publish'};
  assert.equal(checkedJob({jobs:[job]},base,'publish').id,4);
  assert.throws(()=>checkedJob({jobs:[{...job,conclusion:'skipped'}]},base,'publish'),/outcome/);
  assert.throws(()=>checkedJob({jobs:[job,job]},base,'publish'),/ambiguous/);
  assert.equal(shouldCollectToolchain4160('post-merge','4160'),true);
  assert.equal(shouldCollectToolchain4160('pr','4160'),false);
  const good='Complete Toolchain OCI Index ghcr.io/bestnathan/nession-toolchain:gh-2.105.0@sha256:'+
    VERSION_DIGEST['gh-2.105.0']+' platforms={"linux/amd64","linux/arm64"}\nGHCR publish: uploaded=4 reused=0 manifests=3';
  attestPublisherLog(good,'gh-2.105.0');
  assert.throws(()=>attestPublisherLog(good.replace(/uploaded=4/,'uploaded=x'),'gh-2.105.0'),/receipt/);
  assert.throws(()=>attestPublisherLog(good,'jq-1.8.1'),/receipt/);
  assert.equal(equalShaAncestry({base_commit:{sha:FIRST_MAIN},
    merge_base_commit:{sha:FIRST_MAIN},status:'ahead'},FIRST_MAIN,DOCUMENTED_MAIN),true);
  assert.equal(equalShaAncestry({base_commit:{sha:FIRST_MAIN},
    merge_base_commit:{sha:CATALOG_FIRST},status:'ahead'},FIRST_MAIN,DOCUMENTED_MAIN),false);
  console.log('toolchain #4160: source/ref/attempt/job/OCI digest negative fixtures passed');
  return true;
}
