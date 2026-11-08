// Read-only, bounded observation of committed Agent Store *claims*.
// This module never authenticates a Producer, Publisher, implementing PR or Slice.
// Only independently attested records may flow into projectLineage().
import {createHash} from 'node:crypto';
import {decodeAgentResultCandidate} from './agent-result-candidates.mjs';
const SHA=/^[a-f0-9]{40}$/;
const RESULT=/^workflows\/issues\/([1-9][0-9]*)\/results\/([1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{64}\.json)$/;
const validIssue=n=>Number.isSafeInteger(n)&&n>0;
const unavailable=()=>({status:'unavailable',source_ref_sha:null,records:[],truncated:false});
const gitBlobSha=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function decodeBlob(blob,entry){
  if(blob?.encoding!=='base64'||blob.sha!==entry.sha||
     !Number.isSafeInteger(blob.size)||blob.size<2||blob.size>65536||
     typeof blob.content!=='string'||blob.content.length>100000)throw Error('invalid pinned blob');
  const b64=blob.content.replace(/\s/g,'');
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64))
    throw Error('invalid blob encoding');
  const bytes=Buffer.from(b64,'base64');
  if(bytes.length!==blob.size||bytes.length!==entry.size||
     gitBlobSha(bytes)!==entry.sha)throw Error('unpinned result blob');
  return bytes;
}
export async function loadPinnedAgentResultObservations({
  ref,issueNumbers,getTree,getBlob,getCurrentRef,maxFiles=48
}={}){
  if(ref?.state!=='present'||!SHA.test(ref.sha??'')||
     !Array.isArray(issueNumbers)||issueNumbers.length>12||
     issueNumbers.some(n=>!validIssue(n))||
     new Set(issueNumbers).size!==issueNumbers.length||
     !Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>48||
     typeof getTree!=='function'||typeof getBlob!=='function'||
     typeof getCurrentRef!=='function')return unavailable();
  try{
    const tree=await getTree(ref.sha);
    if(!Array.isArray(tree?.tree)||tree.truncated!==false||
       tree.tree.length>5000)return unavailable();
    const selected=new Set(issueNumbers),found=[];
    for(const entry of tree.tree){
      const matched=RESULT.exec(entry.path||'');
      if(!matched||!selected.has(Number(matched[1])))continue;
      if(entry.type!=='blob'||entry.mode!=='100644'||!SHA.test(entry.sha??'')||
         !Number.isSafeInteger(entry.size)||entry.size<2||entry.size>65536)
        return unavailable();
      found.push({issue:Number(matched[1]),filename:matched[2],...entry});
    }
    found.sort((a,b)=>a.issue-b.issue||a.filename.localeCompare(b.filename));
    const truncated=found.length>maxFiles;
    const records=[],seen=new Set();
    for(const entry of found.slice(0,maxFiles)){
      const bytes=decodeBlob(await getBlob(entry.sha),entry);
      const doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      // Qwen write-ahead intent occupies the same canonical results directory
      // but explicitly says publication is not yet attested. Never promote it.
      if(doc?.kind==='trusted_qwen_publisher_write_ahead_intent'||
         doc?.kind==='trusted_publisher_write_ahead_intent')continue;
      const v=decodeAgentResultCandidate(doc,entry.issue,entry.filename,ref.sha,sha256(bytes));
      const key=v.issue+':'+v.run_id+':'+v.attempt+':'+v.action_id;
      if(seen.has(key))throw Error('duplicate candidate');
      seen.add(key);
      records.push({
        issue:v.issue,role:v.role,agent_id:v.agent_id,run_id:v.run_id,
        attempt:v.attempt,action_id:v.action_id,
        claimed_pr_number:v.implementing_pr?.number??null,
        claimed_pr_head_sha:v.implementing_pr?.head_sha_at_attestation??null,
        source_url:'https://github.com/BestNathan/nession/actions/runs/'+v.run_id,
        verification:'unverified_candidate'
      });
    }
    const current=await getCurrentRef();
    if(current?.state!=='present'||current.sha!==ref.sha)return unavailable();
    return {status:truncated?'truncated':'available',
      source_ref_sha:ref.sha,records,truncated};
  }catch{return unavailable();}
}
export function validateAgentResultObservations(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).sort().join(',')!=='records,source_ref_sha,status,truncated'||
     !['available','truncated','unavailable'].includes(value.status)||
     typeof value.truncated!=='boolean'||!Array.isArray(value.records)||
     value.records.length>48||
     (value.status==='unavailable'?
        (value.source_ref_sha!==null||value.records.length!==0||value.truncated):
        (!SHA.test(value.source_ref_sha??'')||
         value.truncated!==(value.status==='truncated'))))
    throw Error('invalid Agent Store observation');
  const seen=new Set();
  for(const r of value.records){
    if(!r||typeof r!=='object'||Array.isArray(r)||
       Object.keys(r).sort().join(',')!==
         'action_id,agent_id,attempt,claimed_pr_head_sha,claimed_pr_number,issue,role,run_id,source_url,verification'||
       !validIssue(r.issue)||!validIssue(r.run_id)||!validIssue(r.attempt)||
       !['developer','reviewer'].includes(r.role)||
       typeof r.agent_id!=='string'||!/^[a-z][a-z0-9-]{1,80}$/.test(r.agent_id)||
       typeof r.action_id!=='string'||!/^[a-f0-9]{64}$/.test(r.action_id)||
       ((r.claimed_pr_number===null)!==(r.claimed_pr_head_sha===null))||
       (r.claimed_pr_number!==null&&
         (!validIssue(r.claimed_pr_number)||!SHA.test(r.claimed_pr_head_sha??'')))||
       r.source_url!=='https://github.com/BestNathan/nession/actions/runs/'+r.run_id||
       r.verification!=='unverified_candidate')
      throw Error('unsafe public Agent Store observation');
    const id=r.issue+':'+r.run_id+':'+r.attempt+':'+r.action_id;
    if(seen.has(id))throw Error('duplicate public candidate');
    seen.add(id);
  }
  return value;
}
