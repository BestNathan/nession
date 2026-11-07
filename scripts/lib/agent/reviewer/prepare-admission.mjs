// #2245: trusted preparation of the Reviewer admission. The host fetches the
// real #2176 source facts and reads the immutable Publisher Store intent; the
// model never supplies the identity, target, file or intent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROLLED_1997_POLICY as POLICY } from '../publisher/controlled-proposal.mjs';
import { admitOriginalControlledReviewerTarget } from './pr-admission.mjs';
import { CONTROLLED_PUBLISHER_INTENT_PATH,
  validateControlledPublisherIntent } from '../publisher/store-intent.mjs';
import { githubFetcher } from '../github-read.mjs';
import {readIssueWorkflowState} from '../orchestration/state-store.mjs';
import {qwenCommittedReviewIntent}
  from '../orchestration/qwen-reviewer-source.mjs';
import {admitQwenPublishedReview,admitQwenRepairPublishedReview}
  from './qwen-pr-admission.mjs';

const PUBLISH_RUN=39609600546;
const OWNER_COMMENT=6317468284;
const PR=2176;
const PR_SHA='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const HEX40=/^[a-f0-9]{40}$/;
const MAX_INTENT=8192;
function fail(message){throw new Error('Reviewer admission prep: '+message);}

// Read only the bounded committed Store intent; it is the replay fence and
// must match the controlled Publisher policy exactly.
export function readStoreIntent(storeRoot){
  const file=path.join(storeRoot,CONTROLLED_PUBLISHER_INTENT_PATH);
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_INTENT)
    fail('unsafe Store intent record');
  return validateControlledPublisherIntent(JSON.parse(fs.readFileSync(file,'utf8')));
}

export async function prepareReviewAdmission({
  reviewerAgentId='review-cursor-01', storeRoot, fetcher,
}){
  if(typeof fetcher!=='function')fail('trusted fetcher required');
  if(typeof storeRoot!=='string'||!storeRoot)fail('Store checkout required');
  const publisherRun=await fetcher('actions/runs/'+PUBLISH_RUN);
  const ownerComment=await fetcher('issues/comments/'+OWNER_COMMENT);
  const pullRequest=await fetcher('pulls/'+PR);
  const head=await fetcher('commits/'+PR_SHA);
  const files=await fetcher('pulls/'+PR+'/files?per_page=100');
  const treeSha=head?.commit?.tree?.sha;
  if(!HEX40.test(treeSha??''))fail('missing exact head tree');
  const tree=await fetcher('git/trees/'+treeSha+'?recursive=1');
  const treeEntry=(Array.isArray(tree?.tree)?tree.tree:[]).find(x=>x?.path===POLICY.file);
  if(!treeEntry)fail('admitted file missing from head tree');
  // Normalize the GitHub commits payload to the admission's source shape.
  const headCommit={sha:head?.sha,tree:{sha:treeSha},
    parents:(Array.isArray(head?.parents)?head.parents:[]).map(x=>({sha:x?.sha}))};
  const storeIntent=readStoreIntent(storeRoot);
  return admitOriginalControlledReviewerTarget({
    publisherRun,ownerComment,pullRequest,headCommit,files,treeEntry,storeIntent,
  },reviewerAgentId);
}

// The generic Qwen path reads the same orphan Store and the real Publisher PR
// independently. No Issue text, model output, or workflow input may select a
// different PR/SHA after the signed Outbox Reviewer action is committed.
export async function prepareQwenReviewAdmission({
  storeRoot,issue,actionId,reviewerAgentId='review-qwen-01',fetcher,
}){
  if(!Number.isSafeInteger(issue)||issue<1||
      !/^[a-f0-9]{64}$/.test(actionId??'')||
      reviewerAgentId!=='review-qwen-01'||typeof fetcher!=='function'||
      typeof storeRoot!=='string'||!storeRoot)
    fail('invalid Qwen Reviewer source request');
  const {state}=readIssueWorkflowState(storeRoot,issue);
  if(!state||state.issue!==issue||state.phase!=='review')
    fail('no committed Qwen Reviewer phase');
  const publisher=state.transitions.filter(t=>t.kind==='publisher'&&
    t.outcome==='published'&&t.target_sha===state.target_sha);
  if(publisher.length!==1)fail('missing unique Publisher transition');
  const committed=qwenCommittedReviewIntent({storeRoot,issue,
    publisherRunId:publisher[0].run_id});
  const intent=committed.record;
  const branch=committed.branch;
  const publisherRun=await fetcher('actions/runs/'+intent.publisher_run_id);
  const pullRequests=await fetcher('pulls?state=all&head=BestNathan:'+
    encodeURIComponent(branch)+'&per_page=100');
  if(!Array.isArray(pullRequests)||pullRequests.length!==1||
      !Number.isSafeInteger(pullRequests[0]?.number)||
      pullRequests[0].number<1)
    fail('no unique published Qwen PR');
  const pr=await fetcher('pulls/'+pullRequests[0].number);
  if(!/^[a-f0-9]{40}$/.test(pr?.head?.sha??''))
    fail('untrusted Qwen PR HEAD SHA');
  const ref=await fetcher('git/ref/heads/'+branch);
  const commit=await fetcher('git/commits/'+pr.head.sha);
  if(!/^[a-f0-9]{40}$/.test(commit?.tree?.sha??''))
    fail('untrusted Qwen Git tree SHA');
  const files=await fetcher('pulls/'+pr.number+'/files?per_page=100');
  const tree=await fetcher('git/trees/'+commit.tree.sha+'?recursive=1');
  return committed.repair
    ? admitQwenRepairPublishedReview({state,intent,publisherRun,pullRequests,
      pr,ref,commit,files,tree,actionId,reviewerAgentId})
    : admitQwenPublishedReview({state,intent,publisherRun,pullRequests,
      pr,ref,commit,files,tree,actionId,reviewerAgentId});
}

async function main(){
  const args=process.argv.slice(2);
  const value=(name)=>{const index=args.indexOf('--'+name);return index>=0?args[index+1]:null;};
  const reviewer=value('reviewer')||'review-cursor-01';
  const storeRoot=value('store');
  const out=value('out');
  if(!storeRoot||!out)fail('usage: --store DIR --out FILE [--reviewer ID]');
  const issue=value('issue'),action=value('action');
  if((issue&&!action)||(!issue&&action))
    fail('Qwen Reviewer source requires both Issue number and signed Action');
  const fetcher=githubFetcher(process.env.GH_TOKEN||process.env.GITHUB_TOKEN);
  const admission=issue
    ?await prepareQwenReviewAdmission({storeRoot,issue:Number(issue),
       actionId:action,reviewerAgentId:reviewer,fetcher})
    :await prepareReviewAdmission({reviewerAgentId:reviewer,storeRoot,fetcher});
  fs.writeFileSync(out,JSON.stringify(admission,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Reviewer admission prepared for '+admission.agent_id+' at '+admission.target_sha);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch((error)=>{console.error('::error::'+error.message);process.exitCode=1;});
}
