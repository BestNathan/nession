// Pinned, read-only orchestration of the existing Qwen Publisher source attester.
// The public build may show only a small exact Issue/PR window; missing or
// ambiguous GitHub/Store evidence means unavailable, never an inferred Pass.
import {createHash} from 'node:crypto';
import {attestQwenPublisherSource} from './qwen-source-attester.mjs';

const SHA=/^[a-f0-9]{40}$/;
const HEX=/^[a-f0-9]{64}$/;
const PRODUCER=/^workflows\/issues\/([1-9][0-9]*)\/producer-results-v2\/([1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{64}\.json)$/;
const INTENT_PREFIX=i=>'workflows/issues/'+i+'/results/';
const unavailable=()=>({status:'unavailable',source_ref_sha:null,records:[],truncated:false});
function check(ok){if(!ok)throw Error('untrusted pinned Qwen lineage source');}
function bytes(blob,entry){
 check(blob?.sha===entry.sha&&blob.encoding==='base64'&&
   Number.isSafeInteger(blob.size)&&blob.size===entry.size&&
   blob.size>=2&&blob.size<=65536&&
   typeof blob.content==='string'&&blob.content.length<=100000);
 const encoded=blob.content.replace(/\s/g,'');
 check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded));
 const result=Buffer.from(encoded,'base64');
 check(result.length===entry.size&&
   createHash('sha1').update('blob '+result.length+'\0').update(result)
     .digest('hex')===entry.sha);
 return result;
}
const validTreeEntry=e=>e?.type==='blob'&&e.mode==='100644'&&
  SHA.test(e.sha??'')&&Number.isSafeInteger(e.size)&&
  e.size>=2&&e.size<=65536;
export async function loadPinnedQwenLineage({
  ref,issueNumbers,pulls,getTree,getBlob,getOriginalStoreBytes,
  getRun,getArtifacts,getArtifactZip,getPull,getCompare,getCurrentRef,
  maxRecords=2,
}={}){
 if(ref?.state!=='present'||!SHA.test(ref.sha??'')||
   !Array.isArray(issueNumbers)||issueNumbers.length>12||
   issueNumbers.some(n=>!Number.isSafeInteger(n)||n<1)||
   !Array.isArray(pulls)||pulls.length>12||
   pulls.some(p=>!Number.isSafeInteger(p?.number)||p.number<1||
     !SHA.test(p.head_sha??''))||
   !Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>4||
   [getTree,getBlob,getOriginalStoreBytes,getRun,getArtifacts,
     getArtifactZip,getPull,getCompare,getCurrentRef].some(x=>typeof x!=='function'))
     return unavailable();
 try{
   check(new Set(issueNumbers).size===issueNumbers.length&&
     new Set(pulls.map(p=>p.number)).size===pulls.length);
   const tree=await getTree(ref.sha);
   check(Array.isArray(tree?.tree)&&tree.truncated===false&&tree.tree.length<=5000);
   const issues=new Set(issueNumbers),prs=new Map(pulls.map(p=>[p.number,p.head_sha]));
   const paths=new Map();
   for(const entry of tree.tree){
     if(!entry?.path)continue;
     if(paths.has(entry.path))throw Error('duplicate Store path');
     paths.set(entry.path,entry);
   }
   const candidate=[];
   for(const [path,entry] of paths){
     const match=PRODUCER.exec(path);
     if(!match||!issues.has(Number(match[1])))continue;
     check(validTreeEntry(entry));
     candidate.push(entry);
   }
   candidate.sort((a,b)=>a.path.localeCompare(b.path));
   const truncated=candidate.length>maxRecords;
   const results=[],seen=new Set();
   for(const entry of candidate.slice(0,maxRecords)){
     const producerBytes=bytes(await getBlob(entry.sha),entry);
     const doc=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(producerBytes));
     const issue=doc.issue,run=doc.result?.run_id,attempt=doc.result?.run_attempt,
       action=doc.action_id,pr=doc.implementing_pr?.number;
     check(issues.has(issue)&&Number.isSafeInteger(run)&&run>0&&
       attempt===1&&HEX.test(action??'')&&
       prs.get(pr)===doc.result?.target_sha&&
       doc.source?.agent_id==='dev-qwen-01'&&
       doc.result?.kind==='developer');
     const key=issue+':'+run+':'+attempt+':'+action;
     check(!seen.has(key));seen.add(key);
     const intentPath=INTENT_PREFIX(issue)+run+'-'+attempt+'-'+action+'.json';
     const intentEntry=paths.get(intentPath);
     check(validTreeEntry(intentEntry));
     const intent=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(
       bytes(await getBlob(intentEntry.sha),intentEntry)));
     const publisherId=intent.publisher_run_id;
     check(Number.isSafeInteger(publisherId)&&publisherId>0);
     const [workerRun,workerArtifacts,publisherRun,publisherArtifacts,pull]
       =await Promise.all([
         getRun(run),getArtifacts(run),getRun(publisherId),
         getArtifacts(publisherId),getPull(pr),
       ]);
     const workerArt=workerArtifacts?.artifacts?.filter(a=>
       a.name==='development-worker-'+run+'-1');
     const publisherArt=publisherArtifacts?.artifacts?.filter(a=>
       a.name==='qwen-developer-v2-'+publisherId+'-1');
     check(workerArt?.length===1&&publisherArt?.length===1);
     const [workerZip,publisherZip]=await Promise.all([
       getArtifactZip(workerArt[0].id),getArtifactZip(publisherArt[0].id)
     ]);
     // The Writer SHA is learned from an independently downloaded
     // Publisher Artifact, then GitHub is asked for that exact author's
     // contents and ancestry before any public edge may be emitted.
     // Never let a candidate self-authorize its own Store writer SHA.
     // The attester will re-verify this Artifact's digest and identity.
     const writerRaw=extractPublisherWriterSha(publisherZip);
     check(SHA.test(writerRaw??''));
     const [originalStoreBytes,storeAncestry]=await Promise.all([
       getOriginalStoreBytes(entry.path,writerRaw),
       getCompare(writerRaw,ref.sha),
     ]);
     const attested=attestQwenPublisherSource({
       storeSha:ref.sha,producerPath:entry.path,producerBytes,
       originalStoreBytes,intent,workerRun,workerArtifacts,workerZip,
       publisherRun,publisherArtifacts,publisherZip,pull,storeAncestry,
     });
     check(attested!==null);
     results.push(attested);
   }
   const current=await getCurrentRef();
   check(current?.state==='present'&&current.sha===ref.sha);
   if(!results.length)return unavailable();
   return {status:truncated?'truncated':'verified',source_ref_sha:ref.sha,
     records:results,truncated};
 }catch{return unavailable();}
}
// Extracts exactly ONE allowed public Writer SHA; not an authentication claim.
// The full ZIP/Artifact metadata is reauthenticated by attestQwenPublisherSource
// before the caller can get an edge. No native or arbitrary member is exposed.
function extractPublisherWriterSha(bytes){
 try{
   if(!Buffer.isBuffer(bytes)||bytes.length<52||bytes.length>512*1024)return null;
   const end=bytes.length-22;
   if(bytes.readUInt32LE(end)!==0x06054b50)return null;
   const count=bytes.readUInt16LE(end+10),offset=bytes.readUInt32LE(end+16),
     size=bytes.readUInt32LE(end+12);
   if(count!==1||size<46||offset+size!==end)return null;
   if(bytes.readUInt32LE(offset)!==0x02014b50)return null;
   const len=bytes.readUInt16LE(offset+28);
   if(bytes.subarray(offset+46,offset+46+len).toString('utf8')!==
       'qwen-publisher-result.json')return null;
   const local=bytes.readUInt32LE(offset+42),comp=bytes.readUInt32LE(offset+20),
     flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10);
   if(method!==0||flags!==0||bytes.readUInt32LE(local)!==0x04034b50)return null;
   const start=local+30+bytes.readUInt16LE(local+26)+
     bytes.readUInt16LE(local+28);
   if(start+comp>offset||comp>8192)return null;
   const doc=JSON.parse(bytes.subarray(start,start+comp).toString('utf8'));
   return SHA.test(doc?.store_commit_sha??'')?doc.store_commit_sha:null;
 }catch{return null;}
}
