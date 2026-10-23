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

const REPO='BestNathan/nession';
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

export function githubFetcher(token){
  if(typeof token!=='string'||token.length<8)fail('trusted read-only token required');
  return async (endpoint)=>{
    const response=await fetch('https://api.github.com/repos/'+REPO+'/'+endpoint,{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28'},
      signal:AbortSignal.timeout(20000),
    });
    if(!response.ok)fail('GitHub read failed: '+endpoint+' ('+response.status+')');
    return response.json();
  };
}

async function main(){
  const args=process.argv.slice(2);
  const value=(name)=>{const index=args.indexOf('--'+name);return index>=0?args[index+1]:null;};
  const reviewer=value('reviewer')||'review-cursor-01';
  const storeRoot=value('store');
  const out=value('out');
  if(!storeRoot||!out)fail('usage: --store DIR --out FILE [--reviewer ID]');
  const admission=await prepareReviewAdmission({
    reviewerAgentId:reviewer,storeRoot,
    fetcher:githubFetcher(process.env.GH_TOKEN||process.env.GITHUB_TOKEN),
  });
  fs.writeFileSync(out,JSON.stringify(admission,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Reviewer admission prepared for '+admission.agent_id+' at '+admission.target_sha);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch((error)=>{console.error('::error::'+error.message);process.exitCode=1;});
}
