import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import {attestAgentOutcome} from './github-dispatch.mjs';
import {validateDevelopmentState} from './outbox.mjs';

const REPO='BestNathan/nession';
const HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
const MAX_ZIP=256*1024, MAX_JSON=64*1024;
const RESULT_KEYS=['kind','issue','run_id','run_attempt','target_sha','outcome','task_id'];
const RECEIPT_V1_FIELDS=['schema_version','kind','issue','action_id','result','source','artifact','acceptance_result'];
const PR_BINDING_FIELDS=['repository','number','head_sha_at_attestation','relation'];
const SOURCE_FIELDS=['repository','path','name','run_id','attempt','event','ref',
  'issue','task_id','agent_id','input_sha','output_sha','verified'];
const ARTIFACT_FIELDS=['id','digest','json_sha256','source_run_id','source_run_attempt'];
// This relation certifies PR HEAD at the producer's point of attestation. It
// does NOT promise that the PR still has that HEAD at Pages publication time.
const PR_RELATION='trusted_pr_head_at_result_attestation';
const OUTCOMES={developer:['implementation_ready'],reviewer:['approved','changes_requested']};
function fail(msg){throw new Error('Agent result ingest: '+msg);}
function positive(n){return Number.isSafeInteger(n)&&n>0;}
function keys(obj,allowed){
  return obj&&typeof obj==='object'&&!Array.isArray(obj)&&
    Object.keys(obj).length===allowed.length&&Object.keys(obj).every(k=>allowed.includes(k));
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) {
    crc^=byte;
    for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^0xffffffff)>>>0;
}
// The only allowed archive is a single regular JSON file, with bounded size.
// ZIP local+central headers, optional data-descriptor and CRC are all checked.
// No external unzip, arbitrary path extraction, symlinks, ZIP64 or directory IO.
export function decodeResultZip(zip,expectedMember='agent-result.json') {
  // Reuse the exact same bounded, no-traversal, one-member ZIP parser for the
  // read-only Controller request Artifact; never allow caller-supplied paths.
  if(!['agent-result.json','controller-request.json'].includes(expectedMember))
    fail('unapproved single-member artifact type');
  if(!Buffer.isBuffer(zip)||zip.length<52||zip.length>MAX_ZIP)fail('archive size/type');
  const end=zip.length-22;
  if(zip.readUInt32LE(end)!==0x06054b50 ||zip.readUInt16LE(end+4)!==0||
    zip.readUInt16LE(end+6)!==0||zip.readUInt16LE(end+8)!==1||
    zip.readUInt16LE(end+10)!==1||zip.readUInt16LE(end+20)!==0)fail('ZIP end-of-central-directory');
  const centralSize=zip.readUInt32LE(end+12),central=zip.readUInt32LE(end+16);
  if(centralSize<46||central+centralSize!==end||central>MAX_ZIP)fail('ZIP central directory bounds');
  if(zip.readUInt32LE(central)!==0x02014b50)fail('ZIP central header');
  const flags=zip.readUInt16LE(central+8),method=zip.readUInt16LE(central+10);
  const crc=zip.readUInt32LE(central+16),compressed=zip.readUInt32LE(central+20);
  const length=zip.readUInt32LE(central+24),nameLen=zip.readUInt16LE(central+28);
  const extraLen=zip.readUInt16LE(central+30),commentLen=zip.readUInt16LE(central+32);
  const localOffset=zip.readUInt32LE(central+42);
  if((flags&~(0x0800|0x0008))!==0||![0,8].includes(method)||
    length>MAX_JSON||compressed>MAX_ZIP||nameLen>100||
    zip.readUInt16LE(central+34)!==0 ||localOffset!==0 ||
    [compressed,length,localOffset].includes(0xffffffff))fail('unsupported ZIP entry');
  if(central+46+nameLen+extraLen+commentLen!==end)fail('ZIP extra entries/trailer');
  const name=zip.subarray(central+46,central+46+nameLen).toString('utf8');
  if(name!==expectedMember||nameLen!==Buffer.byteLength(name))fail('unexpected ZIP member path');
  const unixType=(zip.readUInt32LE(central+38)>>>16)&0o170000;
  if(unixType!==0&&unixType!==0o100000)fail('symlink or nonregular ZIP member');
  if(zip.readUInt32LE(0)!==0x04034b50)fail('ZIP local header');
  if(zip.readUInt16LE(6)!==flags||zip.readUInt16LE(8)!==method)fail('ZIP local/central mismatch');
  const localNameLen=zip.readUInt16LE(26),localExtraLen=zip.readUInt16LE(28);
  if(localNameLen!==nameLen||!zip.subarray(30,30+nameLen).equals(zip.subarray(central+46,central+46+nameLen)))fail('ZIP local member mismatch');
  const start=30+localNameLen+localExtraLen,stop=start+compressed;
  if(start>central||stop>central)fail('ZIP compressed data overlaps index');
  if(!(flags&8)&&(zip.readUInt32LE(14)!==crc||
    zip.readUInt32LE(18)!==compressed||zip.readUInt32LE(22)!==length))fail('ZIP local digest mismatch');
  const gap=central-stop;
  if(flags&8) {
    if(![12,16].includes(gap))fail('ZIP data descriptor length');
    const hasSignature=gap===16;
    if(hasSignature&&zip.readUInt32LE(stop)!==0x08074b50)fail('ZIP descriptor signature');
    const offset=stop+(hasSignature?4:0);
    if(zip.readUInt32LE(offset)!==crc||
       zip.readUInt32LE(offset+4)!==compressed||
       zip.readUInt32LE(offset+8)!==length)fail('ZIP descriptor mismatch');
  } else if(gap!==0)fail('unexpected ZIP trailing data');
  let json;
  try {
    json=method===0?zip.subarray(start,stop):
      inflateRawSync(zip.subarray(start,stop),{maxOutputLength:MAX_JSON+1});
  }catch{fail('invalid or decompression-bomb ZIP entry');}
  if(json.length!==length||json.length>MAX_JSON||crc32(json)!==crc)fail('ZIP extracted length/CRC mismatch');
  return json;
}
export function parseAgentResult(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<2||bytes.length>MAX_JSON)fail('result JSON size');
  let doc;
  try{doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{fail('invalid UTF-8 result JSON');}
  if(!keys(doc,RESULT_KEYS)||!OUTCOMES[doc.kind]?.includes(doc.outcome)||
    !positive(doc.issue)||!positive(doc.run_id)||!positive(doc.run_attempt)||
    !HEX40.test(doc.target_sha??'')||!HEX64.test(doc.task_id??'')) {
    fail('invalid/privilege-bearing Agent result schema');
  }
  return doc;
}
export function createGitHubResultArtifactReader(token,{fetchFn=fetch}={}) {
  if(typeof token!=='string'||token.length<8||typeof fetchFn!=='function')fail('trusted read-only token required');
  const prefix='https://api.github.com/repos/'+REPO;
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28'};
  const get=async(suffix,zip=false)=>{
    const response=await fetchFn(prefix+suffix,{method:'GET',headers});
    if(!response.ok)fail('GitHub result Artifact API rejected read: '+response.status);
    if(!zip)return response.json();
    const announced=Number(response.headers?.get?.('content-length'));
    if(Number.isFinite(announced)&&announced>MAX_ZIP)fail('Artifact HTTP body exceeds bounded archive limit');
    const reader=response.body?.getReader?.();
    if(reader) {
      let total=0;
      const chunks=[];
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        total+=value.length;
        if(total>MAX_ZIP) {
          await reader.cancel();
          fail('Artifact download exceeds bounded archive limit');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks,total);
    }
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>MAX_ZIP)fail('Artifact download exceeds bounded archive limit');
    return bytes;
  };
  return {
    listRunArtifacts:run=>{if(!positive(run))fail('invalid source run');return get('/actions/runs/'+run+'/artifacts?per_page=100');},
    downloadZip:id=>{if(!positive(id))fail('invalid artifact ID');return get('/actions/artifacts/'+id+'/zip',true);},
  };
}
function ownedArtifact(artifacts,run,actionId) {
  const name='agent-result-'+run.id+'-'+run.run_attempt+'-'+actionId;
  if(!Array.isArray(artifacts?.artifacts)||artifacts.total_count!==artifacts.artifacts.length ||
     artifacts.artifacts.length>100)fail('incomplete/paginated artifact listing');
  const found=artifacts.artifacts.filter(x=>x.name===name);
  if(found.length!==1)fail('missing or duplicate matching Agent result artifact');
  const art=found[0];
  const dig=String(art.digest??'');
  const started=Date.parse(run.run_started_at??''),created=Date.parse(art.created_at??'');
  const updated=Date.parse(run.updated_at??'');
  if(!positive(art.id)||art.expired!==false||!/^sha256:[a-f0-9]{64}$/.test(dig)||
    !positive(art.size_in_bytes)||art.size_in_bytes>MAX_ZIP||
    art.workflow_run?.id!==run.id ||art.workflow_run?.head_sha!==run.head_sha||
    !Number.isFinite(started)||!Number.isFinite(created)||!Number.isFinite(updated)||
    created<started-30000||created>updated+300000)fail('untrusted/expired Artifact metadata');
  return art;
}
export async function ingestAgentResult({state,action_id,reader,artifactReader,registry,
  keyring,dispatch_ticket,pr_number,verified_main_sha,now=Date.now()}) {
  validateDevelopmentState(state);
  const pending=state.outbox.find(x=>x.id===action_id && x.status==='dispatched');
  if(!pending||pending.receipt?.status!=='verified'||!positive(pending.receipt.source_run_id)) {
    fail('missing verified Outbox source Run receipt');
  }
  const run=await reader.getRun(pending.receipt.source_run_id);
  const list=await artifactReader.listRunArtifacts(run.id);
  const artifact=ownedArtifact(list,run,action_id);
  const zip=await artifactReader.downloadZip(artifact.id);
  if(zip.length!==artifact.size_in_bytes||sha(zip)!==artifact.digest.slice(7))fail('authenticated ZIP digest mismatch');
  const raw=decodeResultZip(zip);
  const result=parseAgentResult(raw);
  if(result.run_id!==run.id||result.run_attempt!==run.run_attempt||
    result.task_id!==action_id||result.issue!==state.issue||
    result.kind!==pending.task.role)fail('Artifact not bound to expected Run/Issue/Agent task');
  const source=await attestAgentOutcome({
    state,result,dispatch_ticket,pr_number,registry,reader,keyring,now,verified_main_sha});
  // The PR number comes from the trusted ingester's argument, and has already
  // been checked against GitHub REST by attestAgentOutcome. The untrusted
  // worker's JSON cannot supply implementing_pr (parseAgentResult rejects it).
  const implementing_pr={
    repository:REPO,number:pr_number,head_sha_at_attestation:result.target_sha,
    relation:PR_RELATION,
  };
  return validateAuthenticatedAgentReceipt({
    schema_version:2,kind:'authenticated_agent_task_result',
    issue:result.issue,action_id,result,source,
    artifact:{id:artifact.id,digest:artifact.digest,json_sha256:sha(raw),
      source_run_id:run.id,source_run_attempt:run.run_attempt},
    // A result is observation evidence. The Orchestrator still owns transitions,
    // Acceptance owns SC and an authorized human/Publisher owns merge.
    acceptance_result:null,
    implementing_pr,
  });
}
// Public-safe metadata can only be taken from this producer-owned validated
// receipt, never from an Issue body, worker JSON or a PR cross-reference.
// Legacy schema v1 is accepted with no implementing PR inference.
export function validateAuthenticatedAgentReceipt(evidence){
  if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||
     ![1,2].includes(evidence.schema_version))fail('invalid authenticated receipt version');
  const schema=evidence.schema_version;
  const top=schema===2?[...RECEIPT_V1_FIELDS,'implementing_pr']:RECEIPT_V1_FIELDS;
  if(!keys(evidence,top)||
     evidence.kind!=='authenticated_agent_task_result'||!positive(evidence.issue)||
     !HEX64.test(evidence.action_id??'')||
     !keys(evidence.result,RESULT_KEYS)||
     !OUTCOMES[evidence.result.kind]?.includes(evidence.result.outcome)||
     !positive(evidence.result.issue)||evidence.issue!==evidence.result.issue||
     !positive(evidence.result.run_id)||!positive(evidence.result.run_attempt)||
     !HEX40.test(evidence.result.target_sha??'')||
     evidence.result.task_id!==evidence.action_id ||
     !keys(evidence.source,SOURCE_FIELDS) ||
     evidence.source.verified!==true || evidence.source.repository!==REPO||
     !['developer','reviewer'].includes(evidence.result.kind) ||
     evidence.source.path!=='.github/workflows/agent-'+
       (evidence.result.kind==='developer'?'develop':'review')+'.yml' ||
     evidence.source.name!==(evidence.result.kind==='developer'
       ?'Agent / Development':'Agent / Review')||
     evidence.source.ref!=='refs/heads/main' ||
     evidence.source.event!=='workflow_dispatch' ||
     evidence.source.issue!==evidence.issue||
     evidence.source.task_id!==evidence.action_id||
     evidence.source.run_id!==evidence.result.run_id||
     evidence.source.attempt!==evidence.result.run_attempt||
     evidence.source.output_sha!==evidence.result.target_sha||
     !HEX40.test(evidence.source.input_sha??'') ||
     !/^[a-z][a-z0-9-]{1,80}$/.test(evidence.source.agent_id??'') ||
     !keys(evidence.artifact,ARTIFACT_FIELDS)||
     !positive(evidence.artifact.id) ||
     evidence.artifact.source_run_id!==evidence.result.run_id||
     evidence.artifact.source_run_attempt!==evidence.result.run_attempt||
     !/^sha256:[a-f0-9]{64}$/.test(evidence.artifact.digest??'') ||
     !HEX64.test(evidence.artifact.json_sha256??'') ||
     evidence.acceptance_result!==null)fail('untrusted authenticated receipt provenance');
  if(schema===2){
    const p=evidence.implementing_pr;
    if(!keys(p,PR_BINDING_FIELDS)||p.repository!==REPO||!positive(p.number)||
       !HEX40.test(p.head_sha_at_attestation??'') ||
       p.head_sha_at_attestation!==evidence.source.output_sha ||
       p.relation!==PR_RELATION)fail('untrusted authenticated implementing PR binding');
  }
  return evidence;
}
export function appendAuthenticatedResult(root,evidence) {
  validateAuthenticatedAgentReceipt(evidence);
  const parts=['workflows','issues',String(evidence.issue),'results'];
  let current=path.resolve(root);
  if(!fs.existsSync(current)||!fs.lstatSync(current).isDirectory()||
      fs.lstatSync(current).isSymbolicLink())fail('unsafe results store root');
  for(const part of parts){
    current=path.join(current,part);
    if(fs.existsSync(current)){
      const st=fs.lstatSync(current);
      if(!st.isDirectory()||st.isSymbolicLink())fail('unsafe results parent');
    }else fs.mkdirSync(current);
  }
  const filename=evidence.result.run_id+'-'+evidence.result.run_attempt+'-'+evidence.action_id+'.json';
  const dest=path.join(current,filename);
  const data=Buffer.from(JSON.stringify(evidence,null,2)+'\n');
  if(data.length>MAX_JSON)fail('oversized evidence receipt');
  if(fs.existsSync(dest)){
    const st=fs.lstatSync(dest);
    if(!st.isFile()||st.isSymbolicLink()||!fs.readFileSync(dest).equals(data))fail('immutable evidence collision');
    return {changed:false,path:parts.join('/')+'/'+filename};
  }
  fs.writeFileSync(dest,data,{flag:'wx',mode:0o600});
  return {changed:true,path:parts.join('/')+'/'+filename};
}
