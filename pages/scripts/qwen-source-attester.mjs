// Read-only independent Qwen v2 attester (#1974).
// A producer JSON, Publisher Intent, Git commit, or self-declared verified flag
// ALONE never proves lineage. Join the original GitHub-owned Worker Artifact,
// trusted Publisher Run/Artifact, immutable Store bytes/ancestor and exact PR
// HEAD. All inputs are pinned by the caller; no writer credentials here.
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {decodeAgentResultCandidate} from './agent-result-candidates.mjs';

const REPO='BestNathan/nession', SHA=/^[a-f0-9]{40}$/, DIGEST=/^[a-f0-9]{64}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const sha=b=>createHash('sha256').update(b).digest('hex');
const SOURCE=/^workflows\/issues\/([1-9][0-9]*)\/producer-results-v2\/([1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{64}\.json)$/;
function ensure(ok){if(!ok)throw Error('untrusted Qwen producer or Store writer');}
// ZIP extraction is constrained to named regular JSON files, not arbitrary
// paths. It rechecks BOTH original ZIP digests against GitHub Artifact API.
// Worker ZIP includes a bounded encrypted native checkpoint (up to 24 MiB),
// even though only its small result.json member is extracted. Honor the exact
// existing Worker transport budget; the Publisher receipt stays 512 KiB.
const MAX_WORKER_ZIP=32*1024*1024;
const MAX_PUBLISHER_ZIP=512*1024;
function zipMember(zip,name,maxBytes=65536){
 const maxZip=name==='result.json'?MAX_WORKER_ZIP:MAX_PUBLISHER_ZIP;
 ensure(Buffer.isBuffer(zip)&&zip.length>=52&&zip.length<=maxZip);
 const end=zip.length-22;
 ensure(zip.readUInt32LE(end)===0x06054b50&&
   zip.readUInt16LE(end+4)===0&&zip.readUInt16LE(end+6)===0&&
   zip.readUInt16LE(end+20)===0);
 const count=zip.readUInt16LE(end+10),size=zip.readUInt32LE(end+12),
   offset=zip.readUInt32LE(end+16);
 ensure(count>0&&count<=12&&count===zip.readUInt16LE(end+8)&&
   offset+size===end&&offset<zip.length);
 let ptr=offset,found=null;
 for(let i=0;i<count;i++){
   ensure(ptr+46<=end&&zip.readUInt32LE(ptr)===0x02014b50);
   const flags=zip.readUInt16LE(ptr+8),method=zip.readUInt16LE(ptr+10),
     compressed=zip.readUInt32LE(ptr+20),plain=zip.readUInt32LE(ptr+24),
     nameLen=zip.readUInt16LE(ptr+28),extra=zip.readUInt16LE(ptr+30),
     comment=zip.readUInt16LE(ptr+32),local=zip.readUInt32LE(ptr+42);
   ensure((flags&~(0x0800|8))===0&&[0,8].includes(method)&&
     compressed<=maxZip&&plain<=24*1024*1024&&nameLen>0&&nameLen<100&&
     ptr+46+nameLen+extra+comment<=end&&
     zip.readUInt16LE(ptr+34)===0);
   const file=zip.subarray(ptr+46,ptr+46+nameLen).toString('utf8');
   ensure(!file.includes('..')&&!file.includes('\\')&&!file.includes('/')&&
     Buffer.byteLength(file)===nameLen);
   const type=(zip.readUInt32LE(ptr+38)>>>16)&0o170000;
   ensure(type===0||type===0o100000);
   if(file===name){
     ensure(plain<=maxBytes);
     ensure(found===null&&local+30<=offset&&zip.readUInt32LE(local)===0x04034b50);
     const localName=zip.readUInt16LE(local+26),localExtra=zip.readUInt16LE(local+28);
     ensure(localName===nameLen&&
       zip.subarray(local+30,local+30+localName).equals(
         zip.subarray(ptr+46,ptr+46+nameLen))&&
       zip.readUInt16LE(local+8)===method&&zip.readUInt16LE(local+6)===flags);
     const start=local+30+localName+localExtra,stop=start+compressed;
     ensure(stop<=offset);
     let bytes;
     try{bytes=method===8?inflateRawSync(zip.subarray(start,stop),
       {maxOutputLength:maxBytes+1}):zip.subarray(start,stop);}
     catch{throw Error('corrupt compressed original Worker Artifact');}
     ensure(bytes.length===plain&&bytes.length>=2);
     found=bytes;
   }
   ptr+=46+nameLen+extra+comment;
 }
 ensure(ptr===end&&found!==null);
 return found;
}
const originalName=(run,attempt)=>'development-worker-'+run+'-'+attempt;
function runMatches(r,kind){
 return positive(r?.id)&&r.run_attempt===1&&
   r.name===(kind==='worker'?'Agent / Development':'Store / Qwen Publisher')&&
   r.path===(kind==='worker'?'.github/workflows/agent-develop.yml':
     '.github/workflows/store-qwen-publisher.yml')&&
   r.event===(kind==='worker'?'workflow_dispatch':'workflow_run')&&
   r.head_branch==='main'&&SHA.test(r.head_sha??'')&&
   r.status==='completed'&&r.conclusion==='success'&&
   r.repository?.full_name===REPO&&r.head_repository?.full_name===REPO;
}
function artifactFor(list,name,run){
 ensure(Array.isArray(list?.artifacts)&&list.artifacts.length<=100&&
   list.total_count===list.artifacts.length);
 const matches=list.artifacts.filter(a=>a.name===name);
 ensure(matches.length===1&&positive(matches[0].id)&&
   matches[0].expired===false&&
   /^sha256:[a-f0-9]{64}$/.test(matches[0].digest??'')&&
   matches[0].workflow_run?.id===run.id&&
   matches[0].workflow_run?.head_sha===run.head_sha);
 return matches[0];
}
const fields=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).length===k.length&&Object.keys(v).every(x=>k.includes(x));
const PROOF=['schema_version','kind','issue','action_id','developer_run_id',
 'publisher_run_id','pull_request','pr_head_sha','reviewer_action_id','status',
 'store_commit_sha','producer_result_path','producer_result_sha256'];
export function attestQwenPublisherSource({
 storeSha,producerPath,producerBytes,originalStoreBytes,intent,workerRun,
 workerArtifacts,workerZip,publisherRun,publisherArtifacts,publisherZip,
 pull,storeAncestry,
}={}){
 try{
   const match=String(producerPath).match(SOURCE);
   ensure(match&&SHA.test(storeSha??'')&&Buffer.isBuffer(producerBytes)&&
     producerBytes.length>2&&producerBytes.length<=65536&&
     Buffer.isBuffer(originalStoreBytes)&&producerBytes.equals(originalStoreBytes));
   const record=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(producerBytes));
   const candidate=decodeAgentResultCandidate(record,Number(match[1]),match[2],
     storeSha,sha(producerBytes));
   ensure(record.schema_version===2&&candidate.role==='developer'&&
     candidate.agent_id==='dev-qwen-01'&&runMatches(workerRun,'worker')&&
     candidate.run_id===workerRun.id&&candidate.attempt===workerRun.run_attempt&&
     candidate.target_sha===record.implementing_pr.head_sha_at_attestation&&
     record.source.input_sha===workerRun.head_sha);
   const a=artifactFor(workerArtifacts,originalName(workerRun.id,1),workerRun);
   ensure(a.id===record.artifact.id&&a.digest===record.artifact.digest&&
     sha(workerZip)===a.digest.slice(7)&&
     sha(zipMember(workerZip,'result.json'))===record.artifact.json_sha256);
   ensure(runMatches(publisherRun,'publisher')&&
     intent?.kind==='trusted_qwen_publisher_write_ahead_intent'&&
     intent.schema_version===1&&intent.issue===record.issue&&
     intent.action_id===record.action_id&&
     intent.worker_run_id===workerRun.id&&intent.worker_run_attempt===1&&
     intent.worker_source_sha===workerRun.head_sha&&
     intent.publisher_run_id===publisherRun.id&&
     intent.source_sha===publisherRun.head_sha&&
     intent.checkpoint_commit_sha&&SHA.test(intent.checkpoint_commit_sha));
   const writerArtifact=artifactFor(publisherArtifacts,
     'qwen-developer-v2-'+publisherRun.id+'-1',publisherRun);
   ensure(sha(publisherZip)===writerArtifact.digest.slice(7));
   const raw=zipMember(publisherZip,'qwen-publisher-result.json',8192);
   const proof=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
   ensure(fields(proof,PROOF)&&proof.schema_version===1&&
     proof.kind==='trusted_qwen_publisher_handoff'&&
     proof.status==='reviewer_pending'&&
     proof.issue===record.issue&&proof.action_id===record.action_id&&
     proof.developer_run_id===workerRun.id&&
     proof.publisher_run_id===publisherRun.id&&
     proof.producer_result_path===producerPath&&
     proof.producer_result_sha256===sha(producerBytes)&&
     SHA.test(proof.store_commit_sha??'')&&
     proof.pull_request===record.implementing_pr.number&&
     proof.pr_head_sha===record.result.target_sha);
   ensure(pull?.number===proof.pull_request&&
     pull.base?.ref==='main'&&pull.base.repo?.full_name===REPO&&
     pull.head?.repo?.full_name===REPO&&
     pull.head.sha===proof.pr_head_sha&&
     storeAncestry?.merge_base_commit?.sha===proof.store_commit_sha&&
     ['ahead','identical'].includes(storeAncestry.status));
   return Object.freeze({
     issue:record.issue,pr_number:proof.pull_request,
     pr_head_sha:record.result.target_sha,role:'developer',
     agent_id:record.source.agent_id,run_id:workerRun.id,attempt:1,
     action_id:record.action_id,slice_id:null,
     origin:{repository:REPO,source_ref_sha:storeSha,
       producer_run_id:workerRun.id,producer_attempt:1,
       result_digest:sha(producerBytes),writer_receipt_digest:sha(publisherZip),
       source_url:'https://github.com/'+REPO+'/actions/runs/'+workerRun.id},
     verification:'authenticated_at_attestation',
   });
 }catch{return null;}
}
