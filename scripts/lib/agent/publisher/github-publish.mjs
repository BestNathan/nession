// #2137: exact bounded GitHub PR publication. Only a trusted main workflow
// with separately scoped contents/pull-requests write credentials may call this
// after immutable agent-store intent CAS returns may_publish=true.
// A network error or prior committed intent is AMBIGUOUS: never re-POST.
import {createHash} from 'node:crypto';
import {CONTROLLED_1997_POLICY as POLICY} from './controlled-proposal.mjs';
import {CONTROLLED_PUBLISHER_BRANCH as BRANCH,
  validateControlledPublisherIntent} from './store-intent.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const EXPECTED_COMMENT='/nession publish issue=1997 worker_run=39448549052 checkpoint=3';
const CONTENT=Buffer.from(POLICY.content,'utf8');
const sha256=b=>createHash('sha256').update(b).digest('hex');
const gitBlobSha=b=>createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+b.length+'\0'),b,
])).digest('hex');
function fail(reason){throw Error('Trusted Publisher GitHub: '+reason);}
function equal(v,x,k){if(v!==x)fail('mismatched '+k);}
export const CONTROLLED_PUBLISH_COMMENT=EXPECTED_COMMENT;
export function assertControlledPublisherAuthority(env,event){
  if(env?.GITHUB_REPOSITORY!==REPO||
     env.GITHUB_REF!=='refs/heads/main'||
     env.GITHUB_ACTOR!=='BestNathan'||
     env.GITHUB_EVENT_NAME!=='issue_comment'||
     Number(env.GITHUB_RUN_ATTEMPT)!==1||
     !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))||
     Number(env.GITHUB_RUN_ID)<1||
     !SHA.test(env.GITHUB_SHA??'')||
     env.GITHUB_WORKFLOW!=='Store / Controlled Publisher'||
     event?.action!=='created'||
     event.issue?.number!==1997||
     event.issue?.state!=='open'||
     event.comment?.user?.login!=='BestNathan'||
     event.comment?.body!==EXPECTED_COMMENT)
    fail('unauthorized owner/main exact controlled Publisher request');
  return {issuer_run_id:Number(env.GITHUB_RUN_ID),target_main_sha:env.GITHUB_SHA};
}
function guardedIntent(prepared,intent){
  if(prepared?.kind!=='trusted_publisher_preflight_only'||
     prepared.status!=='preflight_only'||
     prepared.issue!==1997||prepared.action_id!==POLICY.action_id||
     prepared.worker_run_id!==POLICY.run_id||
     prepared.worker_run_attempt!==POLICY.attempt||
     prepared.source_sha!==POLICY.source_sha||
     prepared.checkpoint_version!==POLICY.checkpoint_version||
     prepared.checkpoint_commit_sha!==POLICY.checkpoint_commit_sha||
     prepared.source_result_sha256!==sha256(CONTENT)||
     prepared.preflight?.files?.length!==1||
     prepared.preflight.files[0].operation!=='create'||
     prepared.preflight.files[0].path!==POLICY.file||
     prepared.preflight.files[0].new_sha256!==sha256(CONTENT)||
     prepared.patch_sha256!==sha256(Buffer.from(prepared.patch??'')))
    fail('unverified original Worker Publisher preflight');
  if(intent?.status!=='committed'||intent.may_publish!==true||
     !SHA.test(intent.store_commit_sha??''))
    fail('no first immutable Store write-ahead publication grant');
  const record=validateControlledPublisherIntent(intent.record);
  equal(record.action_id,prepared.action_id,'source Action');
  equal(record.worker_run_id,prepared.worker_run_id,'Worker');
  equal(record.source_sha,prepared.source_sha,'Worker Source SHA');
  equal(record.patch_sha256,prepared.patch_sha256,'trusted patch SHA');
  return record;
}
const get=async(api,path)=>{
  const r=await api('GET',path);
  if(!r||typeof r!=='object'||Array.isArray(r))fail('invalid GitHub metadata '+path);
  return r;
};
async function absent(api,endpoint){
  try{await get(api,endpoint);}
  catch(e){
    if(e?.status===404)return;
    throw e;
  }
  fail('preexisting GitHub branch or PR requires read-only reconciliation');
}
export async function publishControlledGitHubPR({prepared,intent,api}){
  if(typeof api!=='function')fail('privileged GitHub API client unavailable');
  const record=guardedIntent(prepared,intent);
  const main=await get(api,'git/ref/heads/main');
  equal(main.ref,'refs/heads/main','trusted main ref');
  equal(main.object?.sha,record.target_main_sha,'stale target main SHA');
  // A previous PR, including a closed PR, is a durable no-redelivery fence.
  const existing=await api('GET','pulls?state=all&head=BestNathan:'+
    encodeURIComponent(BRANCH)+'&per_page=100');
  if(!Array.isArray(existing))fail('incomplete trusted PR listing');
  if(existing.length)fail('existing exact branch PR; reconcile without duplicate POST');
  await absent(api,'git/ref/heads/'+BRANCH);
  const base=await get(api,'git/commits/'+record.target_main_sha);
  const baseTree=base.tree?.sha;
  if(!SHA.test(baseTree??''))fail('invalid GitHub main source tree');
  // Only known trusted canary bytes; Worker result may attest their SHA but
  // cannot supply arbitrary GitHub file contents.
  const blob=await api('POST','git/blobs',
    {content:POLICY.content,encoding:'utf-8'});
  equal(blob?.sha,gitBlobSha(CONTENT),'GitHub original file blob SHA');
  const tree=await api('POST','git/trees',{
    base_tree:baseTree,
    tree:[{path:POLICY.file,mode:'100644',type:'blob',sha:blob.sha}],
  });
  if(!SHA.test(tree?.sha??''))fail('GitHub tree ref unsafe');
  const commit=await api('POST','git/commits',{
    message:'chore(agent): authenticated bounded Developer #1997 candidate',
    tree:tree.sha,parents:[record.target_main_sha],
  });
  if(!SHA.test(commit?.sha??'')||commit.tree?.sha!==tree.sha)
    fail('GitHub commit source/tree mismatch');
  // The single first Git ref/PR POST is allowed by a *fresh* Store CAS only.
  const created=await api('POST','git/refs',{
    ref:'refs/heads/'+BRANCH,sha:commit.sha,
  });
  equal(created?.ref,'refs/heads/'+BRANCH,'new PR branch ref');
  equal(created?.object?.sha,commit.sha,'new PR branch commit');
  const reread=await get(api,'git/ref/heads/'+BRANCH);
  equal(reread.ref,'refs/heads/'+BRANCH,'committed PR branch');
  equal(reread.object?.sha,commit.sha,'committed PR HEAD');
  const pr=await api('POST','pulls',{
    title:'chore(agent): controlled real Cursor Developer fixture #1997',
    body:'Refs #1997.\n\nOriginal authenticated Worker '+POLICY.run_id+'/1.'+
      '\nCheckpoint v'+POLICY.checkpoint_version+' commit '+
      POLICY.checkpoint_commit_sha+
      '\nNative source SHA '+POLICY.source_sha+
      '\nTrusted source patch SHA256 '+record.patch_sha256+
      '\n\nPending independent Reviewer, changes_requested repair and exact-HEAD Acceptance. '+
      'This is a bounded Developer proposal only; no automatic merge.',
    head:BRANCH,base:'main',draft:false,
  });
  if(!Number.isSafeInteger(pr?.number)||pr.number<1)
    fail('GitHub PR did not return a real number');
  const observed=await get(api,'pulls/'+pr.number);
  equal(observed.number,pr.number,'independent PR id');
  equal(observed.head?.sha,commit.sha,'PR actual HEAD');
  equal(observed.head?.ref,BRANCH,'PR actual source branch');
  equal(observed.head?.repo?.full_name,REPO,'PR original repository');
  equal(observed.base?.ref,'main','PR target main');
  if(observed.state!=='open')fail('PR was not observed open');
  const files=await api('GET','pulls/'+pr.number+'/files?per_page=100');
  if(!Array.isArray(files)||files.length!==1||
     files[0].filename!==POLICY.file||files[0].status!=='added'||
     files[0].sha!==blob.sha)
    fail('PR patch modifies unauthorized files or differs from original source bytes');
  return Object.freeze({
    schema_version:1,kind:'authenticated_publisher_pr_receipt',
    issue:1997,action_id:POLICY.action_id,worker_run_id:POLICY.run_id,
    publication_intent_store_sha:intent.store_commit_sha,
    target_main_sha:record.target_main_sha,
    patch_sha256:record.patch_sha256,branch:BRANCH,
    pull_request:pr.number,head_sha:commit.sha,
    file:POLICY.file,content_sha256:sha256(CONTENT),
    status:'published_verified_by_github',
  });
}
