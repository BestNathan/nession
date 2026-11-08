#!/usr/bin/env node
// #1974. Main-owned, read-only artifact transport for independent Qwen Cases.
// The pinned Case itself remains uncredentialed: it independently rechecks
// original Actions Artifact digests, Run/Attempt, Publisher/Store and PR HEAD.
// Nothing from this transport is treated as Acceptance or Store writer proof.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractPublisherWriterSha} from '../../pages/scripts/qwen-lineage-reader.mjs';

const REPO='BestNathan/nession';
const PRODUCER=/^workflows\/issues\/([1-9][0-9]*)\/producer-results-v2\/([1-9][0-9]*)-([1-9][0-9]*)-([a-f0-9]{64})\.json$/;
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^sha256:[a-f0-9]{64}$/;
const MAX_BYTES=32*1024*1024;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const fail=s=>{throw Error('trusted Qwen Artifact pre-stage: '+s);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const blobSha=bytes=>createHash('sha1').update('blob '+bytes.length+'\0')
  .update(bytes).digest('hex');

export function selectQwenSource(tree){
  if(!Array.isArray(tree?.tree)||tree.truncated!==false||tree.tree.length>5000)
    fail('pinned Store tree unavailable or truncated');
  const result=[];
  for(const entry of tree.tree){
    const m=PRODUCER.exec(entry.path??'');
    if(!m)continue;
    if(entry.type!=='blob'||entry.mode!=='100644'||
       !SHA.test(entry.sha??'')||!positive(entry.size)||entry.size>65536)
      fail('noncanonical immutable producer entry');
    result.push({path:entry.path,sha:entry.sha,size:entry.size,
      issue:Number(m[1]),run:Number(m[2]),attempt:Number(m[3]),action:m[4]});
  }
  // This bound agrees with the read-only Acceptance selection (eight).
  if(result.length>8)fail('producer discovery window truncated');
  result.sort((a,b)=>b.run-a.run||b.issue-a.issue||
    a.path.localeCompare(b.path));
  return result.length?result[0]:null;
}
function jsonBlob(blob,selected){
  if(blob?.encoding!=='base64'||blob.sha!==selected.sha||
     blob.size!==selected.size||typeof blob.content!=='string'||
     blob.content.length>100000)
    fail('pinned Store blob metadata drift');
  const bytes=Buffer.from(blob.content.replace(/\s/g,''),'base64');
  if(bytes.length!==selected.size||blobSha(bytes)!==selected.sha)
    fail('pinned Store Git blob checksum mismatch');
  try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}
  catch{fail('pinned Store blob JSON unavailable');}
}
export function selectOriginalArtifact(list,run,name){
  if(!positive(run?.id)||run.run_attempt!==1||
     run.status!=='completed'||run.conclusion!=='success'||
     !Array.isArray(list?.artifacts)||list.total_count!==list.artifacts.length||
     list.artifacts.length>100)fail('untrusted GitHub source Run/Artifact page');
  const matches=list.artifacts.filter(a=>a.name===name);
  if(matches.length!==1||!positive(matches[0].id)||
     matches[0].expired!==false||!DIGEST.test(matches[0].digest??'')||
     matches[0].workflow_run?.id!==run.id||
     matches[0].workflow_run?.head_sha!==run.head_sha)
    fail('missing or ambiguous original Actions Artifact');
  return Object.freeze({id:matches[0].id,digest:matches[0].digest});
}
async function readZip(fetcher,id,token){
  const response=await fetcher('https://api.github.com/repos/'+REPO+
    '/actions/artifacts/'+id+'/zip',{
      headers:{Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        'User-Agent':'nession-trusted-qwen-provenance-transport',
        Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
  if(!response.ok||!response.body)fail('original GitHub Actions ZIP unavailable');
  const length=Number(response.headers.get('content-length'));
  if(Number.isFinite(length)&&length>MAX_BYTES)
    fail('original GitHub Actions ZIP exceeds transport cap');
  const chunks=[];let total=0;
  for await(const chunk of response.body){
    total+=chunk.length;
    if(total>MAX_BYTES)fail('original ZIP stream exceeds transport cap');
    chunks.push(Buffer.from(chunk));
  }
  const buf=Buffer.concat(chunks,total);
  if(buf.length<52)fail('invalid original ZIP archive');
  return buf;
}
export function writePinnedQwenApiReadback(outputDir,storeSha,issue,records){
  if(!SHA.test(storeSha??'')||!positive(issue)||!(records instanceof Map)||
     records.size<8||records.size>32)
    fail('invalid bounded pinned original API source window');
  const target=path.join(outputDir,'api');
  fs.mkdirSync(target,{recursive:false,mode:0o700});
  const entries=[];let total=0;
  for(const [route,bytes] of [...records].sort((a,b)=>a[0].localeCompare(b[0]))){
    if(typeof route!=='string'||route.length>550||
       !route.startsWith('/')||/[\\\r\n]/.test(route)||
       !Buffer.isBuffer(bytes)||bytes.length<2||bytes.length>2*1024*1024)
      fail('unsafe pinned GitHub API source record');
    total+=bytes.length;
    if(total>4*1024*1024)fail('oversized pinned GitHub API source window');
    const name=hash(Buffer.from(route))+'.json';
    fs.writeFileSync(path.join(target,name),bytes,{flag:'wx',mode:0o600});
    entries.push({route,sha256:hash(bytes),size:bytes.length});
  }
  const manifest={schema_version:1,kind:'nession_qwen_github_readback_v1',
    repository:REPO,source_ref_sha:storeSha,issue,entries};
  fs.writeFileSync(path.join(outputDir,'api-manifest.json'),
    JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600});
  return entries.length;
}
export async function stageQwenArtifactBytes({
  getJson,fetcher,token,outputDir,includeApiCache=false,
}={}){
  if(typeof getJson!=='function'||typeof fetcher!=='function'||
     typeof token!=='string'||token.length<8||
     typeof outputDir!=='string'||!path.isAbsolute(outputDir))
    fail('trusted API reader, token and absolute output dir required');
  fs.mkdirSync(outputDir,{recursive:true,mode:0o700});
  if(fs.lstatSync(outputDir).isSymbolicLink()||
     !fs.lstatSync(outputDir).isDirectory()||
     fs.readdirSync(outputDir).length!==0)
    fail('pre-stage destination must be fresh and empty');
  const apiRecords=new Map();
  const read=async route=>{
    if(includeApiCache&&apiRecords.has(route))
      return JSON.parse(apiRecords.get(route).toString('utf8'));
    const value=await getJson(route);
    if(includeApiCache){
      const bytes=Buffer.from(JSON.stringify(value));
      if(bytes.length<2||bytes.length>2*1024*1024)
        fail('oversized GitHub API metadata source');
      apiRecords.set(route,bytes);
    }
    return value;
  };
  const ref=await read('/git/ref/heads/agent-store');
  const sha=ref?.object?.sha;
  if(!SHA.test(sha??''))fail('agent-store ref unavailable');
  const tree=await read('/git/trees/'+sha+'?recursive=1');
  const src=selectQwenSource(tree);
  if(!src)return {status:'no-producer',artifact_count:0};
  const doc=jsonBlob(await read('/git/blobs/'+src.sha),src);
  if(doc?.schema_version!==2||doc?.kind!=='authenticated_agent_task_result'||
     doc.issue!==src.issue||doc.action_id!==src.action||
     doc.result?.run_id!==src.run||doc.result?.run_attempt!==src.attempt||
     doc.result.kind!=='developer'||doc.source?.agent_id!=='dev-qwen-01'||
     !positive(doc.implementing_pr?.number))
    fail('untrusted immutable Qwen Developer v2 source');
  const intentPath='workflows/issues/'+src.issue+'/results/'+
    src.run+'-'+src.attempt+'-'+src.action+'.json';
  const entry=tree.tree.find(e=>e.path===intentPath);
  if(!entry||entry.type!=='blob'||entry.mode!=='100644'||
     !SHA.test(entry.sha??'')||!positive(entry.size)||entry.size>65536)
    fail('missing original immutable Publisher intent');
  const intent=jsonBlob(await read('/git/blobs/'+entry.sha),entry);
  if(intent?.kind!=='trusted_qwen_publisher_write_ahead_intent'||
     intent.issue!==src.issue||intent.action_id!==src.action||
     intent.worker_run_id!==src.run||intent.worker_run_attempt!==1||
     !positive(intent.publisher_run_id))
    fail('Publisher identity is not bound to original Worker');
  const [worker,publisher]=await Promise.all([
    read('/actions/runs/'+src.run),
    read('/actions/runs/'+intent.publisher_run_id),
  ]);
  if(worker?.name!=='Agent / Development'||
     worker.path!=='.github/workflows/agent-develop.yml'||
     worker.event!=='workflow_dispatch'||
     publisher?.name!=='Store / Qwen Publisher'||
     publisher.path!=='.github/workflows/store-qwen-publisher.yml'||
     publisher.event!=='workflow_run'||worker.repository?.full_name!==REPO||
     publisher.repository?.full_name!==REPO)
    fail('original GitHub Run identity mismatch');
  const [workerList,publisherList]=await Promise.all([
    read('/actions/runs/'+worker.id+'/artifacts?per_page=100'),
    read('/actions/runs/'+publisher.id+'/artifacts?per_page=100'),
  ]);
  const artifacts=[
    selectOriginalArtifact(workerList,worker,
      'development-worker-'+worker.id+'-1'),
    selectOriginalArtifact(publisherList,publisher,
      'qwen-developer-v2-'+publisher.id+'-1'),
  ];
  if(artifacts[0].id===artifacts[1].id)fail('duplicate Artifact id across sources');
  const originalZips=[];
  for(const a of artifacts){
    const zip=await readZip(fetcher,a.id,token);
    if('sha256:'+hash(zip)!==a.digest)
      fail('original GitHub Actions ZIP digest mismatch');
    const destination=path.join(outputDir,String(a.id)+'.zip');
    fs.writeFileSync(destination,zip,{flag:'wx',mode:0o600});
    originalZips.push(zip);
  }
  if(includeApiCache){
    const writerSha=extractPublisherWriterSha(originalZips[1]);
    if(!SHA.test(writerSha??''))fail('original Publisher ZIP does not identify Store Writer');
    const required=[
      '/pulls/'+doc.implementing_pr.number,
      '/contents/'+src.path+'?ref='+writerSha,
      '/compare/'+writerSha+'...'+sha,
      '/actions/runs?head_sha='+doc.result.target_sha+'&per_page=100',
    ];
    // SC-03's legacy read-only Store reader also observes the same exact
    // canonical issue results and (if present) genuine Slice blob records.
    const prefix='workflows/issues/'+src.issue+'/';
    const records=tree.tree.filter(e=>e.type==='blob'&&
      typeof e.path==='string'&&e.path.startsWith(prefix)&&
      /\/(?:results|producer-results-v2|slices)\/[^/]+\.json$/.test(e.path));
    if(records.length>16)fail('bounded Issue record readback exceeded');
    for(const e of records){
      if(e.mode!=='100644'||!SHA.test(e.sha??'')||
         !positive(e.size)||e.size>65536)
        fail('unsafe additional Issue source entry');
      required.push('/contents/'+e.path+'?ref='+sha);
    }
    for(const route of required)await read(route);
    // Repeat the live ref read before emitting a fixed source snapshot;
    // never cache a mixed Store revision from a concurrent Publisher CAS.
    const after=await getJson('/git/ref/heads/agent-store');
    if(after?.object?.sha!==sha)
      fail('agent-store moved during trusted Qwen source pre-stage');
    writePinnedQwenApiReadback(outputDir,sha,src.issue,apiRecords);
  }
  return {status:'staged',artifact_count:artifacts.length,
    producer_issue:src.issue,producer_run:src.run};
}
async function liveJson(resource,token){
 const result=await fetch('https://api.github.com/repos/'+REPO+resource,{
   headers:{Accept:'application/vnd.github+json',
     'X-GitHub-Api-Version':'2022-11-28',
     'User-Agent':'nession-trusted-qwen-provenance-transport',
     Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
 if(!result.ok)fail('read-only GitHub API source unavailable');
 return result.json();
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 try{
   if(process.env.GITHUB_ACTIONS!=='true'||
      process.env.GITHUB_REPOSITORY!==REPO||
      process.env.GITHUB_EVENT_NAME!=='push'||
      process.env.GITHUB_REF!=='refs/heads/main'||
      !SHA.test(process.env.GITHUB_SHA??''))
     fail('only trusted main push may preload source bytes');
   const token=process.env.GH_TOKEN;
   const result=await stageQwenArtifactBytes({
     token,outputDir:process.env.NESSION_QWEN_ARTIFACT_DIR,
     getJson:p=>liveJson(p,token),fetcher:fetch,includeApiCache:true,
   });
   console.log('Qwen original source transport: '+result.status+
     '; artifact_count='+result.artifact_count);
 }catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
