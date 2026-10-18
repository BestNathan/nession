// Public-safe lineage presentation contract. Producer-origin authentication is
// deliberately external: neither an Issue cross-reference nor a v2 result
// JSON's "verified" flag can establish a causal edge.
const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const edgeId=r=>r.issue+':'+r.pr_number+':'+r.run_id+':'+r.attempt+':'+r.action_id;
const validAgent=s=>typeof s==='string'&&/^[a-z][a-z0-9-]{1,80}$/.test(s);
const validAction=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const isObject=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const fields=(r,allow)=>isObject(r)&&Object.keys(r).every(x=>allow.includes(x));
const keys=['issue','pr_number','pr_head_sha','role','agent_id','run_id','attempt',
  'action_id','slice_id','origin','verification'];
const originKeys=['repository','source_ref_sha','producer_run_id','producer_attempt',
  'result_digest','writer_receipt_digest','source_url'];
const originDigest=/^[a-f0-9]{64}$/;
function exact(v){return typeof v==='string'&&SHA.test(v);}
function canonicalEdge(raw){
 if(!fields(raw,keys)||!positive(raw.issue)||!positive(raw.pr_number)||
    !exact(raw.pr_head_sha)||!['developer','reviewer'].includes(raw.role)||
    !validAgent(raw.agent_id)||!positive(raw.run_id)||!positive(raw.attempt)||
    !validAction(raw.action_id)||raw.slice_id!==null||
    raw.verification!=='authenticated_at_attestation'||!fields(raw.origin,originKeys)||
    raw.origin.repository!==REPO||!exact(raw.origin.source_ref_sha)||
    !positive(raw.origin.producer_run_id)||!positive(raw.origin.producer_attempt)||
    !originDigest.test(raw.origin.result_digest)||!originDigest.test(raw.origin.writer_receipt_digest)||
    raw.origin.source_url!=='https://github.com/'+REPO+'/actions/runs/'+raw.origin.producer_run_id)
  throw Error('unverified lineage source identity');
 return {
   issue:raw.issue,pr_number:raw.pr_number,pr_head_sha:raw.pr_head_sha,
   role:raw.role,agent_id:raw.agent_id,run_id:raw.run_id,attempt:raw.attempt,
   action_id:raw.action_id,slice_id:null,verification:'authenticated_at_attestation',
   source_ref_sha:raw.origin.source_ref_sha,
   source_url:raw.origin.source_url
 };
}
// The "attested" input MUST come from a future trusted, pinned producer
// reader that separately validates the v2 receipt, writer origin and GitHub
// Run/Attempt. The current Pages build supplies no attested input. Only
// authenticated *historical PR HEAD* is represented, never current SC Pass.
export function projectLineage({issueNumbers=[],pulls=[],attested=null}={}){
 const unavailable={schema_version:1,status:'unavailable',edges:[],truncated:false};
 if(!Array.isArray(issueNumbers)||!Array.isArray(pulls)||
    issueNumbers.length>12||pulls.length>12||issueNumbers.some(x=>!positive(x))||
    pulls.some(p=>!positive(p?.number)||!exact(p.head_sha)))return unavailable;
 if(!attested||!['verified','truncated'].includes(attested.status)||
    !exact(attested.source_ref_sha)||!Array.isArray(attested.records))return unavailable;
 if(attested.records.length>48 ||
    new Set(issueNumbers).size!==issueNumbers.length||
    new Set(pulls.map(p=>p.number)).size!==pulls.length)return unavailable;
 const issueSet=new Set(issueNumbers),prs=new Map(pulls.map(p=>[p.number,p.head_sha]));
 const output=[],byKey=new Map();
 try{
   for(const raw of attested.records){
     const e=canonicalEdge(raw),key=edgeId(e);
     if(raw.origin.source_ref_sha!==attested.source_ref_sha)
       throw Error('cross-source lineage drift');
     // A valid historical attestation whose PR HEAD moved is not a current
     // verified implementing PR edge. Do not infer from matching Issue ids.
     if(!issueSet.has(e.issue)||!prs.has(e.pr_number))continue;
     if(prs.get(e.pr_number)!==e.pr_head_sha)continue;
     const old=byKey.get(key);
     if(old&&JSON.stringify(old)!==JSON.stringify(e))throw Error('ambiguous lineage collision');
     if(!old){byKey.set(key,e);output.push(e);}
   }
 }catch{return unavailable;}
 output.sort((a,b)=>a.issue-b.issue||a.pr_number-b.pr_number||a.run_id-b.run_id||
   a.attempt-b.attempt||a.action_id.localeCompare(b.action_id));
 return {schema_version:1,status:attested.status,edges:output.slice(0,12),
   truncated:attested.status==='truncated'||output.length>12};
}
export function validateLineageProjection(v){
 if(!fields(v,['schema_version','status','edges','truncated'])||v.schema_version!==1||
   !['unavailable','verified','truncated'].includes(v.status)||
   typeof v.truncated!=='boolean'||!Array.isArray(v.edges)||v.edges.length>12||
   (v.status==='unavailable'&&(v.edges.length!==0||v.truncated)))
   throw Error('invalid public lineage contract');
 const seen=new Set();
 for(const e of v.edges){
   if(!fields(e,['issue','pr_number','pr_head_sha','role','agent_id',
      'run_id','attempt','action_id','slice_id','verification','source_ref_sha','source_url'])||
     !positive(e.issue)||!positive(e.pr_number)||!exact(e.pr_head_sha)||
     !['developer','reviewer'].includes(e.role)||!validAgent(e.agent_id)||
     !positive(e.run_id)||!positive(e.attempt)||!validAction(e.action_id)||
     e.slice_id!==null||e.verification!=='authenticated_at_attestation'||
     !exact(e.source_ref_sha)||e.source_url!=='https://github.com/'+REPO+'/actions/runs/'+e.run_id&&
       !/^https:\/\/github\.com\/BestNathan\/nession\/actions\/runs\/[1-9][0-9]*$/.test(e.source_url))
     throw Error('invalid public causal edge');
   if(seen.has(edgeId(e)))throw Error('duplicate public causal edge');
   seen.add(edgeId(e));
 }
 return v;
}
