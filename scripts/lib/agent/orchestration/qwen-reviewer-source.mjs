// #2274: trusted Controller source-ref lookup for a Qwen published Review.
// The existing agent-store contains the signed Publisher Intent and a single
// pending Reviewer action. Only this read-only ref is eligible for Git fetch;
// it grants no model, GitHub, Store or Issue-write permission.
import fs from 'node:fs';
import path from 'node:path';
import {readIssueWorkflowState} from './state-store.mjs';
import {validateQwenPublisherIntent} from '../publisher/store-intent.mjs';

const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
function fail(m){throw Error('trusted Qwen Reviewer source: '+m);}
export function qwenReviewerPublishedSource({storeRoot,issue,actionId,sha}){
  if(typeof storeRoot!=='string'||!storeRoot||
      !Number.isSafeInteger(issue)||issue<1||
      !HEX.test(actionId??'')||!SHA.test(sha??''))
    fail('missing signed source-ref context');
  const {state}=readIssueWorkflowState(storeRoot,issue);
  const reviewer=state?.outbox.filter(x=>x.id===actionId&&
    x.task?.type==='dispatch'&&x.task.role==='reviewer');
  const publisher=state?.transitions.filter(x=>x.kind==='publisher'&&
    x.outcome==='published'&&x.target_sha===sha);
  if(state?.phase!=='review'||state.issue!==issue||
      state.target_sha!==sha||state.assignments?.developer!=='dev-qwen-01'||
      state.assignments?.reviewer!=='review-qwen-01'||
      reviewer?.length!==1||reviewer[0].task.agent_id!=='review-qwen-01'||
      reviewer[0].task.task!=='review'||reviewer[0].task.sha!==sha||
      reviewer[0].status!=='pending'||publisher?.length!==1)
    fail('no exact outstanding authenticated Qwen Reviewer Outbox action');
  const folder=path.join(storeRoot,'workflows/issues',String(issue),'results');
  const entries=fs.readdirSync(folder,{withFileTypes:true});
  if(entries.length>512)fail('unbounded Publisher Intent history');
  const candidates=[];
  for(const file of entries){
    if(!/^[1-9][0-9]*-1-[a-f0-9]{64}\.json$/.test(file.name))continue;
    if(!file.isFile()||file.isSymbolicLink())fail('unsafe Store result entry');
    const full=path.join(folder,file.name),stat=fs.lstatSync(full);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>8192)
      fail('unsafe Publisher Intent bytes');
    let record;
    try{record=JSON.parse(fs.readFileSync(full,'utf8'));}
    catch{fail('invalid Publisher result JSON');}
    if(record?.kind==='trusted_qwen_publisher_write_ahead_intent'&&
       record.issue===issue&&record.publisher_run_id===publisher[0].run_id){
      if(file.name!==record.worker_run_id+'-'+record.worker_run_attempt+
          '-'+record.action_id+'.json')
        fail('Publisher Intent path differs from immutable action');
      candidates.push(validateQwenPublisherIntent(record));
    }
  }
  if(candidates.length!==1)fail('missing unique Qwen publication Intent');
  const original=candidates[0];
  if(original.issue!==issue||original.target_main_sha!==original.source_sha||
      !SHA.test(original.target_main_sha)||
      original.branch!=='agent/'+issue+'/qwen-'+original.action_id.slice(0,16))
    fail('Publisher source branch is not immutable');
  return Object.freeze({branch:'refs/heads/'+original.branch,
    base_sha:original.target_main_sha,review_sha:sha,issue,
    reviewer_action_id:actionId,publisher_run_id:original.publisher_run_id});
}
