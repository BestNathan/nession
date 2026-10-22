// Internal-only, read-only decoder for Git-SHA-pinned canonical Agent Store
// result files. A schema-valid v2 claim is NEVER trusted producer/writer proof.
// Nothing here is called by the public projection until an independent source
// attester (not merely in-record "verified") is implemented.
import {lstat,readdir,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';

const REPO='BestNathan/nession';
const SHA40=/^[a-f0-9]{40}$/, SHA64=/^[a-f0-9]{64}$/;
const VALID_AGENT=/^[a-z][a-z0-9-]{1,80}$/;
const pos=n=>Number.isSafeInteger(n)&&n>0;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,fields)=>object(v)&&Object.keys(v).length===fields.length
  &&Object.keys(v).every(k=>fields.includes(k));
const TOP_V1=['schema_version','kind','issue','action_id','result','source','artifact','acceptance_result'];
const TOP_V2=[...TOP_V1,'implementing_pr'];
const RESULT=['kind','issue','run_id','run_attempt','target_sha','outcome','task_id'];
const SOURCE=['repository','path','name','run_id','attempt','event','ref',
  'issue','task_id','agent_id','input_sha','output_sha','verified'];
const ARTIFACT=['id','digest','json_sha256','source_run_id','source_run_attempt'];
const PR=['repository','number','head_sha_at_attestation','relation'];
const fail=()=>{throw Error('unsafe or unauthenticated Agent receipt claim');};
async function dir(path){
 const st=await lstat(path);
 if(!st.isDirectory()||st.isSymbolicLink())fail();
 return path;
}
export function decodeAgentResultCandidate(doc,issue,filename,storeSha,digest){
 const v=doc?.schema_version;
 if(![1,2].includes(v)||!exact(doc,v===1?TOP_V1:TOP_V2)||
    doc.kind!=='authenticated_agent_task_result'||doc.issue!==issue||
    !SHA64.test(doc.action_id??'')||!exact(doc.result,RESULT)||
    !['developer','reviewer'].includes(doc.result.kind)||
    !pos(doc.result.run_id)||!pos(doc.result.run_attempt)||
    doc.result.task_id!==doc.action_id||doc.result.issue!==issue||
    !SHA40.test(doc.result.target_sha??'')||
    !['developer','reviewer'].includes(doc.result.kind)||
    (doc.result.kind==='developer'&&doc.result.outcome!=='implementation_ready')||
    (doc.result.kind==='reviewer'&&!['approved','changes_requested'].includes(doc.result.outcome))||
    filename!==doc.result.run_id+'-'+doc.result.run_attempt+'-'+doc.action_id+'.json'||
    !exact(doc.source,SOURCE)||doc.source.repository!==REPO||
    doc.source.issue!==issue||doc.source.task_id!==doc.action_id||
    doc.source.run_id!==doc.result.run_id||
    doc.source.attempt!==doc.result.run_attempt||
    doc.source.agent_id===null||!VALID_AGENT.test(doc.source.agent_id??'')||
    !SHA40.test(doc.source.input_sha??'')||
    doc.source.output_sha!==doc.result.target_sha||
    doc.source.verified!==true||
    doc.source.event!=='workflow_dispatch'||
    doc.source.ref!=='refs/heads/main'||
    doc.source.path!=='.github/workflows/agent-'+
      (doc.result.kind==='developer'?'develop':'review')+'.yml'||
    doc.source.name!==(doc.result.kind==='developer'?'Agent / Development':'Agent / Review')||
    !exact(doc.artifact,ARTIFACT)||!pos(doc.artifact.id)||
    !/^sha256:[a-f0-9]{64}$/.test(doc.artifact.digest??'')||
    !SHA64.test(doc.artifact.json_sha256??'')||
    doc.artifact.source_run_id!==doc.result.run_id||
    doc.artifact.source_run_attempt!==doc.result.run_attempt||
    doc.acceptance_result!==null||!SHA40.test(storeSha??'')||
    !SHA64.test(digest??''))fail();
 let pr=null;
 if(v===2){
   const p=doc.implementing_pr;
   if(!exact(p,PR)||p.repository!==REPO||!pos(p.number)||
      !SHA40.test(p.head_sha_at_attestation??'')||
      p.head_sha_at_attestation!==doc.result.target_sha||
      p.relation!=='trusted_pr_head_at_result_attestation')fail();
   pr={number:p.number,head_sha_at_attestation:p.head_sha_at_attestation};
 }
 // Private source-bound *candidate* only. Deliberately omit the raw record,
 // provider payloads, arbitrary URLs, names of native Sessions and secrets.
 return Object.freeze({
   kind:'unverified_result_candidate',version:v,issue,run_id:doc.result.run_id,
   attempt:doc.result.run_attempt,action_id:doc.action_id,
   role:doc.result.kind,agent_id:doc.source.agent_id,
   target_sha:doc.result.target_sha,
   implementing_pr:pr,artifact_id:doc.artifact.id,
   artifact_digest:doc.artifact.digest,artifact_json_sha256:doc.artifact.json_sha256,
   store_sha:storeSha,receipt_sha256:digest,
 });
}
const unavailable=()=>({status:'unavailable',source_ref_sha:null,candidates:[]});
export async function scanPinnedAgentCandidates({root,expectedSha,issues,maxFiles=100}={}){
 if(!SHA40.test(expectedSha??'')||!Array.isArray(issues)||
    issues.length===0||issues.length>12||new Set(issues).size!==issues.length||
    issues.some(n=>!pos(n))||!Number.isSafeInteger(maxFiles)||
    maxFiles<1||maxFiles>200)return unavailable();
 try {
   const abs=resolve(root);await dir(abs);
   const head=execFileSync('git',['-C',abs,'rev-parse','HEAD'],{
     encoding:'utf8',timeout:5000}).trim();
   const top=execFileSync('git',['-C',abs,'rev-parse','--show-toplevel'],{
     encoding:'utf8',timeout:5000}).trim();
   if(head!==expectedSha||resolve(top)!==abs)fail();
   const dirty=execFileSync('git',['-C',abs,'status','--porcelain','--untracked-files=all'],{
     encoding:'utf8',timeout:5000}).trim();
   if(dirty)fail();
   const entries=execFileSync('git',['-C',abs,'ls-tree','--name-only','HEAD'],{
     encoding:'utf8',timeout:5000}).trim();
   if(!entries)return {status:'empty',source_ref_sha:head,candidates:[]};
   if(!entries.split('\n').includes('workflows'))fail();
   await dir(join(abs,'workflows'));await dir(join(abs,'workflows','issues'));
   const candidates=[],seen=new Set();let scanned=0,truncated=false;
   for(const issue of [...issues].sort((a,b)=>a-b)){
     let folder;
     try{folder=await dir(join(abs,'workflows','issues',String(issue),'results'));}
     catch(err){if(err.code==='ENOENT')continue;throw err;}
     const files=(await readdir(folder,{withFileTypes:true}))
       .sort((a,b)=>a.name.localeCompare(b.name));
     for(const entry of files){
       if(!/^[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{64}\.json$/.test(entry.name)||
          !entry.isFile()||entry.isSymbolicLink())fail();
       if(scanned++>=maxFiles){truncated=true;break;}
       const path=join(folder,entry.name),st=await lstat(path);
       if(st.isSymbolicLink()||!st.isFile()||st.size<2||st.size>65536)fail();
       const bytes=await readFile(path);
       const digest=createHash('sha256').update(bytes).digest('hex');
       const candidate=decodeAgentResultCandidate(
         JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),
         issue,entry.name,head,digest);
       const key=issue+':'+candidate.run_id+':'+candidate.attempt+':'+candidate.action_id;
       if(seen.has(key))fail();
       seen.add(key);candidates.push(candidate);
     }
     if(truncated)break;
   }
   return {status:truncated?'truncated':'available',source_ref_sha:head,
     candidates:candidates.slice(0,maxFiles)};
 }catch{return unavailable();}
}
// This is intentionally NOT a public-lineage verifier. The canonical v2 JSON
// and a readable Git tree cannot prove authenticated writer origin or a Slice.
export function authenticatedLineageFromCandidates(){
 return null; // no independent Writer/Producer/SC attestation has been supplied
}
