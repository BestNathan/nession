// #4445: independently produced PR-stage Acceptance, never Issue prose as authority.
import {createHash} from 'node:crypto';
import {buildAcceptanceContext,normalizeAcceptanceResult} from '../../../acceptance-executor.mjs';
import {parseAcceptanceReport,extractSection} from '../../../requirement-acceptance.mjs';
import {validPrRequiredQualityReceipt,collectPrRequiredQualityAsync} from '../../../acceptance-pr-web-quality-receipt.mjs';
import {decodeResultZip} from './result-artifact.mjs';
import {acceptTaskResult,recordDispatch,validateDevelopmentState} from './outbox.mjs';
import {approvedBinding,prMatches,associated,stateDigest} from './quality-reconcile.mjs';
const REPO='BestNathan/nession',PATH='.github/workflows/acceptance-pr-quality-waker.yml',NAME='Acceptance / PR Quality Waker';
const SHA=/^[a-f0-9]{40}$/,positive=n=>Number.isSafeInteger(n)&&n>0;
const digest=b=>createHash('sha256').update(b).digest('hex');
const pending=reason=>({status:'pending',reason});
function validRun(run,id){
  return run?.id===id&&positive(run.run_attempt)&&run.name===NAME&&
    [PATH,PATH+'@refs/heads/main'].includes(run.path)&&run.event==='workflow_run'&&
    run.head_branch==='main'&&SHA.test(run.head_sha??'')&&run.status==='completed'&&
    run.conclusion==='success'&&run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO;
}
function goodJob(jobs,name,steps,run){
  const found=jobs.filter(j=>j.name===name);
  return found.length===1&&found[0].run_id===run.id&&found[0].run_attempt===run.run_attempt&&
    found[0].status==='completed'&&found[0].conclusion==='success'&&positive(found[0].id)&&
    steps.every(step=>found[0].steps?.filter(s=>s.name===step&&s.status==='completed'&&s.conclusion==='success').length===1);
}
export function acceptanceResultMatches(doc,context,quality){
  try{
    if(doc?.schema_version!==1||doc.issue!==context.issue.number||doc.stage!=='pr'||
        doc.run_id!==context.run_id||doc.target_ref!==context.target_ref||doc.deployment!==null||
        doc.contract_sha256!==context.contract_sha256||doc.source!=='agent-qwen'||
        !Array.isArray(doc.selected_criteria)||!Array.isArray(doc.criteria))return false;
    const required=context.criteria.map(c=>c.criterion).sort();
    if(!required.length||JSON.stringify([...doc.selected_criteria].sort())!==JSON.stringify(required))return false;
    const normalized=normalizeAcceptanceResult(context,doc,doc.source);
    if(!normalized.criteria.every(c=>c.result==='Pass'))return false;
    const q=doc.pr_required_quality_receipt;
    return validPrRequiredQualityReceipt(q,context.target_ref)&&q.run_id===quality.run_id&&
      q.run_attempt===quality.run_attempt&&q.scope_job_id===quality.scope_job_id&&
      q.web_check_job_id===quality.web_check_job_id;
  }catch{return false;}
}
export async function planAcceptanceReconciliation({state,expectedVersion,reviewerReceipt,request,registry,artifactReader}){
  validateDevelopmentState(state);
  if(state.version!==expectedVersion)throw Error('stale state CAS');
  if(state.phase!=='acceptance'||state.assignments.acceptor!=='accept-qwen-01')return pending('not awaiting supported PR Acceptance');
  const latest=state.transitions.at(-1),sha=state.target_sha;
  if(latest?.kind!=='quality'||latest.outcome!=='passed'||latest.target_sha!==sha)return pending('missing exact-HEAD Quality transition');
  const prNumber=approvedBinding(state,reviewerReceipt);
  const actions=state.outbox.filter(a=>a.task.type==='verify'&&a.task.gate==='sc-acceptance'&&
    a.task.when==='pr'&&a.task.sha===sha&&a.status==='pending');
  if(!prNumber||actions.length!==1)return pending('no current approved PR or unique PR Acceptance action');
  const action=actions[0],prefix='/repos/'+REPO;
  const pr=await request(prefix+'/pulls/'+prNumber);
  if(!prMatches(pr,prNumber,sha))return pending('PR changed');
  const issue=await request(prefix+'/issues/'+state.issue);
  if(issue?.number!==state.issue||issue.state!=='open'||issue.pull_request)return pending('owning Issue not open');
  // Use the projected run IDs ONLY as bounded candidate locators. The exact
  // trusted run/attempt, artifact digest, normalized contract and quality proof
  // below independently establish the result.
  const report=parseAcceptanceReport(extractSection(issue.body,'Acceptance Report'));
  const ids=[...new Set([...report.rows.values()].flatMap(r=>{
    const m=/^run ([1-9][0-9]*); ref ([a-f0-9]{40});/.exec(r.evidence);
    return m&&m[2]===sha&&positive(Number(m[1]))?[Number(m[1])]:[];
  }))].sort((a,b)=>b-a).slice(0,8);
  const qp=await collectPrRequiredQualityAsync(sha,async endpoint=>{
    const value=await request(endpoint);
    if(endpoint.includes('/actions/workflows/ci-quality.yml/runs?')){
      if(!Array.isArray(value?.workflow_runs)||value.total_count>value.workflow_runs.length)return {workflow_runs:[]};
      return {...value,workflow_runs:value.workflow_runs.filter(run=>associated(run,pr))};
    }
    return value;
  });
  if(qp.status!=='pass'||qp.receipt.run_id!==latest.run_id||qp.receipt.run_attempt!==latest.attempt)
    return pending('Quality proof superseded or unavailable');
  for(const id of ids){
    const run=await request(prefix+'/actions/runs/'+id);
    if(!validRun(run,id))continue;
    const attempt=run.run_attempt;
    const context=buildAcceptanceContext(issue,'pr',{runId:id,targetRef:sha,method:'agent'});
    const all=buildAcceptanceContext(issue,'pr',{runId:id,targetRef:sha});
    if(!context.criteria.length||context.criteria.length!==all.criteria.length)continue;
    const payload=await request(prefix+'/actions/runs/'+id+'/attempts/'+attempt+'/jobs?per_page=100');
    if(!Array.isArray(payload.jobs)||payload.total_count!==payload.jobs.length||payload.jobs.length>=100)continue;
    const jobPrefix='evaluate ('+state.issue+') / ';
    if(!goodJob(payload.jobs,'select',['Authenticate completed Quality and select outstanding exact-HEAD Issues'],run)||
       !goodJob(payload.jobs,jobPrefix+'Execute acceptance',['Prepare stage-specific immutable acceptance context','Normalize and freeze machine-readable result','Upload structured Acceptance Result'],run)||
       !goodJob(payload.jobs,jobPrefix+'Deterministic Issue updater',['Apply Acceptance Report and checkbox projection'],run))continue;
    const listed=await artifactReader.listRunArtifacts(id);
    if(!Array.isArray(listed.artifacts)||listed.total_count!==listed.artifacts.length||listed.artifacts.length>=100)continue;
    const name='acceptance-result-'+state.issue+'-pr-'+id+'-'+attempt;
    const arts=listed.artifacts.filter(a=>a.name===name);
    if(arts.length!==1)continue;
    const art=arts[0];
    if(!positive(art.id)||art.expired!==false||!/^sha256:[a-f0-9]{64}$/.test(art.digest??'')||
       art.workflow_run?.id!==id||art.workflow_run?.head_sha!==run.head_sha||
       art.workflow_run?.repository_id!==pr.base.repo.id||art.workflow_run?.head_repository_id!==pr.base.repo.id||
       !positive(art.size_in_bytes)||art.size_in_bytes>262144)continue;
    const zip=await artifactReader.downloadZip(art.id);
    if(zip.length!==art.size_in_bytes||'sha256:'+digest(zip)!==art.digest)continue;
    const bytes=decodeResultZip(zip,'acceptance-result.json');
    const doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!acceptanceResultMatches(doc,context,qp.receipt))continue;
    const live=await request(prefix+'/pulls/'+prNumber),again=await request(prefix+'/actions/runs/'+id);
    const currentIssue=await request(prefix+'/issues/'+state.issue);
    const qrun=await request(prefix+'/actions/runs/'+latest.run_id);
    if(!prMatches(live,prNumber,sha)||!validRun(again,id)||again.run_attempt!==attempt||again.head_sha!==run.head_sha||
       currentIssue.state!=='open'||currentIssue.number!==state.issue||
       buildAcceptanceContext(currentIssue,'pr',{runId:id,targetRef:sha,method:'agent'}).contract_sha256!==context.contract_sha256||
       !associated(qrun,live)||qrun.id!==latest.run_id||qrun.run_attempt!==latest.attempt||
       qrun.status!=='completed'||qrun.conclusion!=='success')continue;
    const acknowledged=recordDispatch(state,expectedVersion,action.id,{status:'verified',dispatch_id:action.id,source_run_id:id});
    const result={kind:'acceptance',issue:state.issue,run_id:id,run_attempt:attempt,target_sha:sha,outcome:'passed',task_id:action.id};
    const source={repository:REPO,path:PATH,name:NAME,run_id:id,attempt,event:'workflow_run',ref:'refs/heads/main',
      issue:state.issue,task_id:action.id,agent_id:null,input_sha:sha,output_sha:sha,verified:true};
    const next=acceptTaskResult(acknowledged,acknowledged.version,result,source,registry);
    return {status:'verified',pr:prNumber,action_id:action.id,expectedVersion,expectedDigest:stateDigest(state),
      acknowledged,next,acceptance_receipt:{source,artifact_id:art.id,artifact_sha256:art.digest,json_sha256:digest(bytes),
        contract_sha256:doc.contract_sha256,criteria:doc.selected_criteria,quality_receipt:qp.receipt}};
  }
  return pending('no authenticated complete exact-HEAD PR Acceptance artifact');
}
