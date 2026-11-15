// #3655: trusted read-only, source-pinned historical #3433 Qwen recovery proof.
// Never infer a verdict from Issue text, model output or a nearby green workflow.
import {createHash} from 'node:crypto';

const REPO='BestNathan/nession',ISSUE=3433;
const A='a9b3f9e1d78ef5c9ae0f97136d753da0ca6fc9ba';
const B='1159e58c19b927b4e53d4fe594174a50b6bbf092';
const FINAL_SHA='d6f6e70958336f8f4b80433be510bf54a1f55c08';
const SHA=/^[0-9a-f]{40}$/,DIGEST=/^sha256:[0-9a-f]{64}$/;
const ELIGIBLE=new Set([3550,3574,3578,3583,3589,3592]);
const VERSIONS=[6,7,9,10,13,14,16,17,19,20];
const RUNS=Object.freeze({
  initialPublisher:[43607502468,'Store / Qwen Publisher','store-qwen-publisher.yml','workflow_dispatch','github-actions[bot]','3ec79d6f290d297cbdc3554c5713773033a23cce','success'],
  firstController:[43667355262,'Agent / Controller Dispatch','agent-controller-dispatch.yml','issue_comment','BestNathan','b0c3b58e5a39e48252f0c9be167be3985c283dad','success'],
  firstReview:[43667393107,'Agent / Review','agent-review.yml','workflow_dispatch','github-actions[bot]','b0c3b58e5a39e48252f0c9be167be3985c283dad','failure'],
  recoveredReview:[43669396046,'Agent / Review','agent-review.yml','workflow_dispatch','github-actions[bot]','27c0b832f5202db8c6a8f86fa279c3c1a877c0e6','success'],
  firstReviewIngest:[43669808885,'Store / Agent Review Result Ingest','store-agent-review-result-ingest.yml','repository_dispatch','github-actions[bot]','27c0b832f5202db8c6a8f86fa279c3c1a877c0e6','success'],
  repairController:[43677442901,'Agent / Controller Dispatch','agent-controller-dispatch.yml','issue_comment','BestNathan','f9cc75bfe9bc05cfd3e9785090ff93273221efbb','success'],
  repairWorker:[43677482758,'Agent / Development','agent-develop.yml','workflow_dispatch','github-actions[bot]','f9cc75bfe9bc05cfd3e9785090ff93273221efbb','success'],
  repairIngest:[43678458924,'Store / Agent Development Ingest','store-agent-development-ingest.yml','issue_comment','BestNathan','5ae7fbf46408c81b36f62a1705de469687a91cd3','success'],
  failedPublisher:[43678506569,'Store / Qwen Publisher','store-qwen-publisher.yml','workflow_run','BestNathan','5ae7fbf46408c81b36f62a1705de469687a91cd3','failure'],
  repairPublisher:[43681716536,'Store / Qwen Publisher','store-qwen-publisher.yml','workflow_run','BestNathan','af25010e06a4c39eb172d9ab1df7ab16c83853cd','success'],
  malformedReview:[43681851455,'Agent / Review','agent-review.yml','workflow_dispatch','github-actions[bot]','af25010e06a4c39eb172d9ab1df7ab16c83853cd','failure'],
  finalReview:[43711883444,'Agent / Review','agent-review.yml','workflow_dispatch','github-actions[bot]',FINAL_SHA,'success'],
  finalIngest:[43712269121,'Store / Agent Review Result Ingest','store-agent-review-result-ingest.yml','repository_dispatch','github-actions[bot]',FINAL_SHA,'success'],
});
export const QWEN_3433_RUN_SPECS=RUNS;
function deny(message){throw Error('trusted #3433 Qwen recovery evidence: '+message);}
function check(test,message){if(!test)deny(message);}
function pair(state,id){return state?.outbox?.find(x=>x.id===id);}
function last(state,kind){return state?.transitions?.filter(x=>x.kind===kind).at(-1);}
function validOutbox(o,role,task,status,sourceRun){
  return o?.task?.type==='dispatch'&&o.task.role===role&&o.task.task===task&&
    o.status===status&&(sourceRun==null||o.receipt?.source_run_id===sourceRun);
}
export function attestQwen3433Recovery({issue,stage,targetSha,states,head,runs,
  failedArtifacts,finalArtifacts,jobs,pr,sourceAncestry,targetAncestry}){
  check(ELIGIBLE.has(issue)&&['pr','post-merge'].includes(stage)&&
    SHA.test(targetSha??''),'unrecognized target Issue/stage/SHA');
  check(sourceAncestry?.behind_by===0&&
    ['ahead','identical'].includes(sourceAncestry.status)&&
    targetAncestry?.behind_by===0&&
    ['ahead','identical'].includes(targetAncestry.status),
  'source PR or historical acceptance target is not an ancestor');
  check(pr?.number===3530&&pr?.head?.repo?.full_name===REPO&&
    SHA.test(pr.head.sha??'')&&pr.changed_files===1&&
    (pr.state==='open'||(pr.state==='closed'&&pr.merged_at!=null)),
    'wrong published PR or its source scope');
  check(head?.version>=20&&head.version<=1024&&
    head.path==='workflows/issues/3433/states/'+String(head.version).padStart(8,'0')+'.json'&&
    /^[a-f0-9]{64}$/.test(head.sha256??''),'invalid committed Store head');
  for(const version of VERSIONS){
    const s=states?.[version];
    check(s?.issue===ISSUE&&s.version===version&&s.schema_version===1&&
      Array.isArray(s.transitions)&&Array.isArray(s.outbox)&&
      s.assignments?.developer==='dev-qwen-01'&&
      s.assignments?.reviewer==='review-qwen-01','missing/modified immutable Store v'+version);
  }
  const v=states;
  check(v[6].phase==='review'&&v[6].target_sha===A&&
    v[6].outbox.length===1&&
    validOutbox(v[6].outbox[0],'reviewer','review','dispatched',RUNS.firstReview[0]),
    'pre-model signed Reviewer source not admitted');
  const old=v[6].outbox[0],replacement=v[7].outbox.find(o=>o.id!==old.id);
  check(v[7].phase==='review'&&v[7].target_sha===A&&v[7].outbox.length===2&&
    pair(v[7],old.id)?.status==='failed'&&
    pair(v[7],old.id)?.receipt?.source_run_id===RUNS.firstReview[0]&&
    pair(v[7],old.id)?.receipt?.failure_code===
      'qwen_reviewer_publisher_trigger_pre_model_failure'&&
    validOutbox(replacement,'reviewer','review','pending')&&
    replacement.task.sha===A&&replacement.attempts===0,
    'CAS-retired pre-model Reviewer or unique successor is missing');
  check(validOutbox(pair(v[9],replacement.id),'reviewer','review','dispatched',
    RUNS.recoveredReview[0])&&
    last(v[10],'reviewer')?.run_id===RUNS.recoveredReview[0]&&
    last(v[10],'reviewer')?.outcome==='changes_requested'&&
    last(v[10],'reviewer')?.target_sha===A&&v[10].phase==='repair',
    'recovered first Reviewer lacks authenticated verdict/Store ingest');
  const repair=v[10].outbox.find(o=>o.task.role==='developer');
  check(validOutbox(repair,'developer','repair','pending')&&
    validOutbox(pair(v[13],repair.id),'developer','repair','dispatched',
      RUNS.repairWorker[0])&&v[13].phase==='repair',
    'signed native Qwen Repair worker is not dispatched');
  check(v[14].phase==='review'&&v[14].target_sha===B&&
    last(v[14],'publisher')?.run_id===RUNS.repairPublisher[0]&&
    last(v[14],'publisher')?.outcome==='published'&&
    last(v[14],'publisher')?.target_sha===B,
    'authenticated Repair Publisher did not publish original source B');
  const malformed=v[14].outbox.find(o=>o.task.role==='reviewer');
  check(validOutbox(malformed,'reviewer','review','pending')&&
    malformed.task.sha===B&&
    validOutbox(pair(v[16],malformed.id),'reviewer','review','dispatched',
      RUNS.malformedReview[0]),'first post-Repair Reviewer was not signed');
  const recovered=v[17].outbox.find(o=>o.id!==old.id&&o.id!==malformed.id);
  check(v[17].phase==='review'&&
    pair(v[17],malformed.id)?.status==='failed'&&
    pair(v[17],malformed.id)?.receipt?.failure_code===
      'qwen_reviewer_invalid_json_after_model'&&
    validOutbox(recovered,'reviewer','review','pending')&&recovered.task.sha===B&&
    validOutbox(pair(v[19],recovered.id),'reviewer','review','dispatched',
      RUNS.finalReview[0]),'malformed JSON CAS recovery replay/forgery');
  check(v[20].phase==='quality'&&v[20].target_sha===B&&
    last(v[20],'reviewer')?.run_id===RUNS.finalReview[0]&&
    last(v[20],'reviewer')?.outcome==='approved'&&
    last(v[20],'reviewer')?.target_sha===B&&
    v[20].outbox.some(o=>o.task.type==='verify'&&o.task.gate==='quality'&&
      o.task.sha===B&&o.status==='pending')&&
    pair(v[20],old.id)?.status==='failed'&&
    pair(v[20],malformed.id)?.status==='failed',
    'signed final Reviewer approval or immutable failure audit is missing');
  for(const [role,spec] of Object.entries(RUNS)){
    const run=runs?.[role];
    check(run?.id===spec[0]&&run.name===spec[1]&&
      run.path==='.github/workflows/'+spec[2]&&
      run.event===spec[3]&&run.actor?.login===spec[4]&&
      run.head_sha===spec[5]&&run.conclusion===spec[6]&&
      run.run_attempt===1&&run.head_branch==='main'&&
      run.status==='completed'&&
      run.repository?.full_name===REPO&&
      run.head_repository?.full_name===REPO,
      'untrusted GitHub '+role+' Run/Attempt/Actor/SHA');
  }
  for(const [key,wanted] of [
    ['firstReview',{prepare:'failure',review:'skipped','notify-metrics':'skipped'}],
    ['repairWorker',{claim:'success','qwen-developer':'success'}],
    ['finalReview',{prepare:'success',review:'success','notify-metrics':'success'}],
  ]){
    const listing=jobs?.[key];
    check(Array.isArray(listing?.jobs)&&listing.total_count===listing.jobs.length&&
      Object.entries(wanted).every(([name,conclusion])=>
        listing.jobs.filter(j=>j.name===name&&j.conclusion===conclusion&&
          j.status==='completed'&&j.run_id===RUNS[key][0]).length===1),
      'untrusted '+key+' exact Jobs');
  }
  function verifyArtifacts(list,expected,runKey){
    const spec=RUNS[runKey],runId=spec[0];
    check(Array.isArray(list?.artifacts)&&list.total_count===expected.length&&
      list.artifacts.length===expected.length,'extra/missing '+runKey+' Artifact');
    for(const name of expected){
      const matches=list.artifacts.filter(x=>x.name===name),a=matches[0];
      check(matches.length===1&&Number.isSafeInteger(a.id)&&a.id>0&&
        Number.isSafeInteger(a.size_in_bytes)&&a.size_in_bytes>0&&
        a.expired===false&&DIGEST.test(a.digest??'')&&
        a.workflow_run?.id===runId&&a.workflow_run?.head_sha===spec[5],
        'forged '+runKey+' immutable '+name+' Artifact');
    }
  }
  verifyArtifacts(failedArtifacts,[
    'review-admission-43681851455-1','review-claim-43681851455-1'
  ],'malformedReview');
  verifyArtifacts(finalArtifacts,[
    'review-admission-43711883444-1','review-claim-43711883444-1',
    'reviewer-slice-43711883444-1',
    'agent-telemetry-reviewer-slice-43711883444-1',
    'agent-result-43711883444-1-'+recovered.id
  ],'finalReview');
  return Object.freeze({
    schema_version:1,kind:'authenticated_qwen_3433_recovery',
    verified:true,issue,root_issue:3433,historical_target_sha:targetSha,
    later_observation_main_sha:FINAL_SHA,original_published_pr_sha:B,
    original_pr_number:3530,original_pr_current_head:pr.head.sha,
    store_branch:'agent-store',store_head_version:head.version,
    source_state_versions:VERSIONS,
    protected_state_chain:[
      {version:6,phase:'review',reviewer_run:RUNS.firstReview[0]},
      {version:7,phase:'review',source_failed_run:RUNS.firstReview[0],
        successor_action:replacement.id},
      {version:9,phase:'review',successor_run:RUNS.recoveredReview[0]},
      {version:10,phase:'repair',reviewer_outcome:'changes_requested',
        reviewer_run:RUNS.recoveredReview[0]},
      {version:13,phase:'repair',repair_worker_run:RUNS.repairWorker[0]},
      {version:14,phase:'review',publisher_run:RUNS.repairPublisher[0],
        target_sha:B},
      {version:16,phase:'review',malformed_reviewer_run:RUNS.malformedReview[0]},
      {version:17,phase:'review',failed_json_action:malformed.id,
        successor_action:recovered.id},
      {version:19,phase:'review',successor_run:RUNS.finalReview[0]},
      {version:20,phase:'quality',approved_reviewer_run:RUNS.finalReview[0],
        target_sha:B},
    ],
    independently_authenticated_runs:Object.fromEntries(
      Object.entries(RUNS).map(([key,s])=>[key,{id:s[0],name:s[1],
        main_sha:s[5],conclusion:s[6],attempt:1}])),
    final_reviewer_artifacts:finalArtifacts.artifacts.map(a=>({
      id:a.id,name:a.name,digest:a.digest
    })),
    historical_target_is_ancestor_of_later_observation:true,
    published_source_is_ancestor_of_original_pr:true,
    next_stage:'quality',quality_outcome:'unverified',
  });
}
export function decodeQwen3433StoreContent(obj,path){
  check(obj?.type==='file'&&obj.path===path&&obj.encoding==='base64'&&
    SHA.test(obj.sha??'')&&Number.isSafeInteger(obj.size)&&obj.size>0&&
    obj.size<256*1024&&typeof obj.content==='string',
    'invalid signed Store GitHub Contents record');
  const bytes=Buffer.from(obj.content.replace(/\s/g,''),'base64');
  const blobSha=createHash('sha1')
    .update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
  check(bytes.length===obj.size&&blobSha===obj.sha,'Store Git blob hash mismatch');
  try{return {value:JSON.parse(bytes.toString('utf8')),
    digest:createHash('sha256').update(bytes).digest('hex')};}
  catch{deny('invalid immutable Store JSON');}
}
export async function collectQwen3433Recovery({
  repo,issue,stage,targetSha,get
}={}){
  if(!ELIGIBLE.has(issue)||!['pr','post-merge'].includes(stage))return null;
  check(repo===REPO&&SHA.test(targetSha??'')&&typeof get==='function',
    'invalid authenticated collection request');
  const prefix='/repos/'+REPO;
  const storePath=ver=>'workflows/issues/3433/states/'+
    String(ver).padStart(8,'0')+'.json';
  const contents=path=>get(prefix+'/contents/'+path+'?ref=agent-store')
    .then(x=>decodeQwen3433StoreContent(x,path));
  const jobsKeys=['firstReview','repairWorker','finalReview'];
  const pr=await get(prefix+'/pulls/3530');
  const [headFile,sourceAncestry,targetAncestry,...rest]=await Promise.all([
    contents('workflows/issues/3433/head.json'),
    get(prefix+'/compare/'+B+'...'+pr.head.sha),
    get(prefix+'/compare/'+targetSha+'...'+FINAL_SHA),
    ...VERSIONS.map(v=>contents(storePath(v))),
    ...Object.values(RUNS).map(spec=>get(prefix+'/actions/runs/'+spec[0])),
    get(prefix+'/actions/runs/'+RUNS.malformedReview[0]+'/artifacts?per_page=100'),
    get(prefix+'/actions/runs/'+RUNS.finalReview[0]+'/artifacts?per_page=100'),
    ...jobsKeys.map(k=>get(prefix+'/actions/runs/'+RUNS[k][0]+'/jobs?per_page=100')),
  ]);
  const head=headFile.value;
  const count=VERSIONS.length,runCount=Object.keys(RUNS).length;
  const states=Object.fromEntries(VERSIONS.map((v,i)=>[v,rest[i].value]));
  const runs=Object.fromEntries(Object.keys(RUNS).map((k,i)=>[k,rest[count+i]]));
  const [failedArtifacts,finalArtifacts]=rest.slice(count+runCount,count+runCount+2);
  const jobs=Object.fromEntries(jobsKeys.map((k,i)=>[k,rest[count+runCount+2+i]]));
  check(head.version>=20&&head.version<=1024,'invalid current Store version');
  const latest=await contents(storePath(head.version));
  check(latest.digest===head.sha256&&latest.value.version===head.version&&
    latest.value.issue===ISSUE,'uncommitted Store HEAD/digest');
  return attestQwen3433Recovery({issue,stage,targetSha,states,head,runs,
    failedArtifacts,finalArtifacts,jobs,pr,sourceAncestry,targetAncestry});
}
