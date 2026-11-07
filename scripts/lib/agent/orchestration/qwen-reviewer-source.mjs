// #2274: trusted Controller source-ref lookup for a Qwen published Review.
// The existing agent-store contains the signed Publisher Intent and a single
// pending Reviewer action. Only this read-only ref is eligible for Git fetch;
// it grants no model, GitHub, Store or Issue-write permission.
import fs from 'node:fs';
import path from 'node:path';
import {readIssueWorkflowState} from './state-store.mjs';
import {validateQwenPublisherIntent} from '../publisher/store-intent.mjs';
import {validateQwenRepairPublisherIntent}
  from '../publisher/qwen-repair-intent.mjs';

const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
function fail(m){throw Error('trusted Qwen Reviewer source: '+m);}
// The immutable Publisher Intent is the single source of Qwen published
// Developer/Reviewer/Repair lineage, not the Issue body or a model field.
// All consumers must check their own current State phase and target SHA.
export function qwenCommittedPublisherIntent({storeRoot,issue,publisherRunId}){
  if(typeof storeRoot!=='string'||!storeRoot||
     !Number.isSafeInteger(issue)||issue<1||
     !Number.isSafeInteger(publisherRunId)||publisherRunId<1)
    fail('missing authenticated Publisher Intent lookup');
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
       record.issue===issue&&record.publisher_run_id===publisherRunId){
      if(file.name!==record.worker_run_id+'-'+record.worker_run_attempt+
          '-'+record.action_id+'.json')
        fail('Publisher Intent path differs from immutable action');
      candidates.push(validateQwenPublisherIntent(record));
    }
  }
  if(candidates.length!==1)fail('missing unique Qwen publication Intent');

  return candidates[0];
}

// A review may follow either the initial publication or a same-PR Repair
// update. Both are immutable Publisher write-ahead records at the same
// branch; a Repair record additionally binds SHA A (`source_sha`) and the
// original main/base + publisher. Return exactly the record for the current
// Publisher Run, tagged so the admission can select the right parent check.
export function qwenCommittedReviewIntent({storeRoot,issue,publisherRunId}){
  if(typeof storeRoot!=='string'||!storeRoot||
     !Number.isSafeInteger(issue)||issue<1||
     !Number.isSafeInteger(publisherRunId)||publisherRunId<1)
    fail('missing authenticated Publisher Intent lookup');
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
    if(record?.issue!==issue||record?.publisher_run_id!==publisherRunId)continue;
    if(record.kind==='trusted_qwen_publisher_write_ahead_intent'){
      candidates.push({repair:false,record:validateQwenPublisherIntent(record),
        branch:record.branch});
    }else if(record.kind==='trusted_qwen_repair_publisher_write_ahead'){
      const valid=validateQwenRepairPublisherIntent(record);
      candidates.push({repair:true,record:valid,
        branch:valid.branch.replace(/^refs\/heads\//,'')});
    }
  }
  if(candidates.length!==1)
    fail('missing unique Qwen review publication Intent');
  return Object.freeze(candidates[0]);
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
