// #2274: trusted Controller source-ref lookup for a Qwen published Review.
// The existing agent-store contains the signed Publisher Intent and a single
// pending Reviewer action. Only this read-only ref is eligible for Git fetch;
// it grants no model, GitHub, Store or Issue-write permission.
import fs from 'node:fs';
import path from 'node:path';
import {readIssueWorkflowState} from './state-store.mjs';
import {validateQwenPublisherIntent,qwenPublisherIntentPath}
  from '../publisher/store-intent.mjs';
import {validateQwenRepairPublisherIntent,qwenRepairPublisherIntentPath}
  from '../publisher/qwen-repair-intent.mjs';

const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
function fail(m){throw Error('trusted Qwen Reviewer source: '+m);}
// The immutable Publisher Intent is the single source of Qwen published
// Developer/Reviewer/Repair lineage, not the Issue body or a model field.
// All consumers must check their own current State phase and target SHA.
// The old v1 intents share results/ with canonical Result receipts. New v2
// intents have a collision-free, immutable publisher-intents/ namespace.
// Read both exact layouts, never move or rewrite historical Store objects.
function readQwenPublisherIntents(storeRoot,issue){
  const prefix='workflows/issues/'+issue+'/';
  const matched=[];
  let total=0;
  for(const bucket of ['results','publisher-intents']){
    const folder=path.join(storeRoot,prefix,bucket);
    let entries;
    try{entries=fs.readdirSync(folder,{withFileTypes:true});}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    total+=entries.length;
    if(total>512)fail('unbounded Publisher Intent history');
    for(const file of entries){
      if(!/^[1-9][0-9]*-1-[a-f0-9]{64}\\.json$/.test(file.name))continue;
      if(!file.isFile()||file.isSymbolicLink())fail('unsafe Store result entry');
      const full=path.join(folder,file.name),stat=fs.lstatSync(full);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>65536)
        fail('unsafe Publisher Intent bytes');
      let record;
      try{record=JSON.parse(fs.readFileSync(full,'utf8'));}
      catch{fail('invalid Publisher result JSON');}
      if(record?.kind==='trusted_qwen_publisher_write_ahead_intent'){
        if(stat.size>8192)fail('oversized Qwen Publisher intent');
        const checked=validateQwenPublisherIntent(record);
        if(prefix+bucket+'/'+file.name!==qwenPublisherIntentPath(checked))
          fail('Publisher Intent path differs from immutable action');
        matched.push({repair:false,record:checked});
      }else if(record?.kind==='trusted_qwen_repair_publisher_write_ahead'){
        if(stat.size>8192)fail('oversized Qwen Repair intent');
        const checked=validateQwenRepairPublisherIntent(record);
        if(prefix+bucket+'/'+file.name!==qwenRepairPublisherIntentPath(checked))
          fail('Repair Intent path differs from immutable action');
        matched.push({repair:true,record:checked});
      }else if(bucket==='publisher-intents'){
        fail('publisher-intents contains non-Intent content');
      }
    }
  }
  return matched;
}
export function qwenCommittedPublisherIntent({storeRoot,issue,publisherRunId}){
  if(typeof storeRoot!=='string'||!storeRoot||
     !Number.isSafeInteger(issue)||issue<1||
     !Number.isSafeInteger(publisherRunId)||publisherRunId<1)
    fail('missing authenticated Publisher Intent lookup');
  const matches=readQwenPublisherIntents(storeRoot,issue).filter(x=>
    !x.repair&&x.record.publisher_run_id===publisherRunId);
  if(matches.length!==1)fail('missing unique Qwen publication Intent');
  return matches[0].record;
}
export function qwenCommittedReviewIntent({storeRoot,issue,publisherRunId}){
  if(typeof storeRoot!=='string'||!storeRoot||
     !Number.isSafeInteger(issue)||issue<1||
     !Number.isSafeInteger(publisherRunId)||publisherRunId<1)
    fail('missing authenticated Publisher Intent lookup');
  const matches=readQwenPublisherIntents(storeRoot,issue).filter(x=>
    x.record.publisher_run_id===publisherRunId);
  if(matches.length!==1)fail('missing unique Qwen review publication Intent');
  const chosen=matches[0],record=chosen.record;
  return Object.freeze({repair:chosen.repair,record,
    branch:chosen.repair?record.branch.replace(/^refs\\/heads\\//,''):record.branch});
}
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
      !['pending','dispatched'].includes(reviewer[0].status)||
      (reviewer[0].status==='dispatched'&&(
        reviewer[0].receipt?.status!=='verified'||
        reviewer[0].receipt?.dispatch_id!==actionId||
        !Number.isSafeInteger(reviewer[0].receipt?.source_run_id)||
        reviewer[0].receipt.source_run_id<1))||
      publisher?.length!==1)
    fail('no exact outstanding authenticated Qwen Reviewer Outbox action');
  const committed=qwenCommittedReviewIntent({storeRoot,issue,
    publisherRunId:publisher[0].run_id});
  const record=committed.record;
  const branch=committed.branch;
  const base_sha=committed.repair?record.original_main_sha:record.target_main_sha;
  if(record.issue!==issue||
      (!committed.repair&&record.target_main_sha!==record.source_sha)||
      (committed.repair&&record.original_main_sha===record.source_sha)||
      !SHA.test(base_sha??'')||
      branch!=='agent/'+issue+'/qwen-'+
        (committed.repair?record.branch.split('/').at(-1).slice(5):
          record.action_id.slice(0,16)))
    fail('Publisher source branch is not immutable');
  return Object.freeze({branch:'refs/heads/'+branch,
    base_sha,review_sha:sha,issue,
    reviewer_action_id:actionId,publisher_run_id:record.publisher_run_id});
}
