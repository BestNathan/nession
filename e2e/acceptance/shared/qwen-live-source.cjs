'use strict';
// Source-selected, read-only #1974 Qwen acceptance. A historical intent,
// PR mention or Store blob alone is NEVER accepted as producer/writer proof.
// The independently authenticated Pages attester remains the one verifier.
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {HEX40,REPO}=require('./agent-store-1997.cjs');
const API='https://api.github.com/repos/'+REPO;
// #1974: only the trusted Main pre-stage can fetch authenticated API bytes.
// Case code never sees its token. The pinned private snapshot still undergoes
// all canonical original SHA, ZIP, Run/Artifact, PR and Store checks.
function readPinnedQwenApi(route,root=process.env.NESSION_QWEN_ARTIFACT_DIR,
  runnerTemp=process.env.RUNNER_TEMP){
  assert.ok(typeof route==='string'&&route.startsWith('/')&&
    route.length<=550&&!/[\\\r\n]/.test(route)&&
    !route.split('/').some(x=>x==='.'||x==='..'),
    'unsafe cached GitHub source route');
  assert.ok(typeof root==='string'&&typeof runnerTemp==='string'&&
    path.isAbsolute(root)&&path.isAbsolute(runnerTemp)&&
    root===path.join(runnerTemp,'qwen-lineage-source'),
    'missing trusted private Qwen readback directory');
  const dir=fs.lstatSync(root);
  assert.ok(dir.isDirectory()&&!dir.isSymbolicLink(),
    'unsafe private Qwen readback directory');
  const manifestPath=path.join(root,'api-manifest.json');
  let stat;
  try{stat=fs.lstatSync(manifestPath);}
  catch{throw Error('missing or unsafe Qwen source readback manifest');}
  assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>=40&&
    stat.size<=65536,'missing or unsafe Qwen source readback manifest');
  const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  assert.ok(m?.schema_version===1&&
    m.kind==='nession_qwen_github_readback_v1'&&m.repository===REPO&&
    /^[a-f0-9]{40}$/.test(m.source_ref_sha??'')&&positive(m.issue)&&
    Array.isArray(m.entries)&&m.entries.length>=8&&m.entries.length<=32,
    'untrusted Qwen readback source manifest');
  const candidates=m.entries.filter(e=>e.route===route);
  assert.equal(candidates.length,1,'missing or ambiguous pinned GitHub API route');
  const e=candidates[0];
  assert.ok(e.sha256&&/^[a-f0-9]{64}$/.test(e.sha256)&&
    Number.isSafeInteger(e.size)&&e.size>=2&&e.size<=2*1024*1024,
    'invalid pinned read-only GitHub source bounds');
  const apiDir=path.join(root,'api');
  let d;
  try{d=fs.lstatSync(apiDir);}
  catch{throw Error('unsafe pinned source API directory');}
  assert.ok(d.isDirectory()&&!d.isSymbolicLink(),
    'unsafe pinned source API directory');
  const file=path.join(apiDir,
    createHash('sha256').update(route).digest('hex')+'.json');
  let fileStat;
  try{fileStat=fs.lstatSync(file);}
  catch{throw Error('missing or unsafe original GitHub source body');}
  assert.ok(fileStat.isFile()&&!fileStat.isSymbolicLink()&&
    fileStat.size===e.size,'stale or unsafe original GitHub source body');
  const bytes=fs.readFileSync(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),e.sha256,
    'original GitHub source metadata checksum mismatch');
  const json=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  if(route==='/git/ref/heads/agent-store')
    assert.equal(json?.object?.sha,m.source_ref_sha,
      'pinned agent-store source identity mismatch');
  return json;
}
async function api(route){
  assert.ok(typeof route==='string'&&route.startsWith('/')&&
    !route.split('/').some(part=>part==='..'||part==='.'),'unsafe source API route');
  if(process.env.NESSION_QWEN_ARTIFACT_DIR)
    return readPinnedQwenApi(route);
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  const headers={'Accept':'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
    'User-Agent':'nession-qwen-case-source'};
  if(typeof token==='string'&&token.length>=8)
    headers.Authorization='Bearer '+token;
  const res=await fetch(API+route,{headers,signal:AbortSignal.timeout(15000)});
  assert.equal(res.ok,true,'trusted read-only Qwen source API unavailable: '+res.status);
  return res.json();
}
const PRODUCER=/^workflows\/issues\/([1-9][0-9]*)\/producer-results-v2\/([1-9][0-9]*)-([1-9][0-9]*)-([a-f0-9]{64})\.json$/;
const sha1=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const unavailable=(reason,storeSha=null)=>({status:'unavailable',reason,storeSha,fixture:null,attested:null});
const positive=n=>Number.isSafeInteger(n)&&n>0;
function decodeGitBlob(blob,entry){
  assert.equal(blob?.encoding,'base64');
  assert.equal(blob?.sha,entry.sha);
  assert.ok(positive(blob.size)&&blob.size===entry.size&&blob.size<=65536);
  assert.equal(typeof blob.content,'string');
  assert.ok(blob.content.length<=100000);
  const encoded=blob.content.replace(/\s/g,'');
  assert.match(encoded,/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
  const bytes=Buffer.from(encoded,'base64');
  assert.equal(bytes.length,entry.size);
  assert.equal(sha1(bytes),entry.sha);
  return bytes;
}
function selectNewestQwenProducer(tree,{maxEntries=8}={}){
  assert.ok(Array.isArray(tree?.tree)&&tree.truncated===false&&tree.tree.length<=5000);
  const matches=[];
  for(const entry of tree.tree){
    const found=PRODUCER.exec(entry.path??'');
    if(!found)continue;
    assert.equal(entry.type,'blob');
    assert.equal(entry.mode,'100644');
    assert.match(entry.sha??'',HEX40);
    assert.ok(positive(entry.size)&&entry.size<=65536);
    matches.push({entry,issue:Number(found[1]),runId:Number(found[2]),
      attempt:Number(found[3]),actionId:found[4]});
  }
  // Bounded newest-first deterministic selection, with no silently
  // discarded/truncated unverified newer source.
  assert.ok(matches.length<=maxEntries,'Qwen producer source window truncated');
  matches.sort((a,b)=>b.runId-a.runId||b.issue-a.issue||
    a.entry.path.localeCompare(b.entry.path));
  return matches;
}
// The same independently bounded 32 MiB original Worker transport
// (encrypted native checkpoint included) is used by Pages and Case Runner.
// The privileged Publisher proof remains independently restricted to 512 KiB.
const MAX_SOURCE_ARTIFACT_ZIP_BYTES=32*1024*1024;
// Trusted main-only workflow fetches and digest-verifies the original ZIPs
// in a separate credentialed step. Case code receives *only those bytes*;
// it independently checks GitHub Artifact Run metadata/digest and Store Writer.
// No GITHUB_TOKEN/GH_TOKEN is supplied to the Case or PR-head execution.
function preStagedOriginalZip(id,root=process.env.NESSION_QWEN_ARTIFACT_DIR,
  runnerTemp=process.env.RUNNER_TEMP){
  assert.ok(positive(id),'invalid original Actions Artifact id');
  assert.ok(typeof root==='string'&&typeof runnerTemp==='string'&&
    path.isAbsolute(root)&&path.isAbsolute(runnerTemp)&&
    root===path.join(runnerTemp,'qwen-lineage-source'),
    'missing trusted main-only Artifact transport');
  const dir=fs.lstatSync(root);
  assert.ok(dir.isDirectory()&&!dir.isSymbolicLink(),
    'unsafe Artifact pre-stage directory');
  const source=path.join(root,String(id)+'.zip');
  let stat;
  try{stat=fs.lstatSync(source);}
  catch{throw Error('missing or unsafe pre-staged original Artifact ZIP');}
  assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>=52&&
    stat.size<=MAX_SOURCE_ARTIFACT_ZIP_BYTES,
    'missing or unsafe pre-staged original Artifact ZIP');
  return fs.readFileSync(source);
}
async function originalZip(id){
  assert.ok(positive(id),'invalid original Actions Artifact id');
  if(process.env.NESSION_QWEN_ARTIFACT_DIR)
    return preStagedOriginalZip(id);
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  assert.ok(typeof token==='string'&&token.length>=8,
    'read-only GitHub Actions Artifact token unavailable');
  const res=await fetch(API+'/actions/artifacts/'+id+'/zip',{
    headers:{'Accept':'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      'User-Agent':'nession-qwen-source-acceptance',
      Authorization:'Bearer '+token},
    signal:AbortSignal.timeout(20000)});
  assert.equal(res.ok,true,'original GitHub Artifact unavailable');
  const size=Number(res.headers.get('content-length'));
  assert.ok(!Number.isFinite(size)||size<=MAX_SOURCE_ARTIFACT_ZIP_BYTES,'oversized Actions Artifact');
  let total=0;const parts=[];
  assert.ok(res.body,'missing Actions Artifact stream');
  for await(const part of res.body){
    total+=part.length;
    assert.ok(total<=MAX_SOURCE_ARTIFACT_ZIP_BYTES,'oversized Actions Artifact stream');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts,total);
}
async function attestLatestQwenProducer(){
  const store=await api('/git/ref/heads/agent-store');
  const storeSha=store?.object?.sha;
  assert.match(storeSha??'',HEX40,'missing pinned agent-store identity');
  const tree=await api('/git/trees/'+storeSha+'?recursive=1');
  const entries=selectNewestQwenProducer(tree);
  if(!entries.length)return {status:'missing',
    reason:'No real Qwen Developer Result v2 committed yet',storeSha,
    fixture:null,attested:null};
  const candidate=entries[0],blob=await api('/git/blobs/'+candidate.entry.sha);
  const bytes=decodeGitBlob(blob,candidate.entry);
  const doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  assert.equal(doc.schema_version,2);
  assert.equal(doc.kind,'authenticated_agent_task_result');
  assert.equal(doc.issue,candidate.issue);
  assert.equal(doc.result?.run_id,candidate.runId);
  assert.equal(doc.result?.run_attempt,candidate.attempt);
  assert.equal(doc.action_id,candidate.actionId);
  assert.equal(doc.source?.agent_id,'dev-qwen-01');
  assert.equal(doc.result?.kind,'developer');
  assert.ok(positive(doc.implementing_pr?.number));
  assert.match(doc.result.target_sha??'',HEX40);
  const secondRef=await api('/git/ref/heads/agent-store');
  assert.equal(secondRef?.object?.sha,storeSha,'agent-store ref drift during discovery');
  // The candidate's PR is an untrusted discovery pointer. Neither its
  // self-declared verified flag nor this Blob grants a causal edge.
  const {loadPinnedQwenLineage}=await import(
    '../../../pages/scripts/qwen-lineage-reader.mjs');
  const ref={state:'present',sha:storeSha};
  const readGitBlob=async sha=>api('/git/blobs/'+sha);
  const getOriginalStoreBytes=async(file,writer)=>{
    assert.match(writer??'',HEX40);
    assert.match(file,/^workflows\/issues\/[1-9][0-9]*\/producer-results-v2\/[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{64}\.json$/);
    const old=await api('/contents/'+file+'?ref='+writer);
    return decodeGitBlob(old,{sha:old.sha,size:old.size});
  };
  const verified=await loadPinnedQwenLineage({
    ref,issueNumbers:[candidate.issue],
    pulls:[{number:doc.implementing_pr.number,head_sha:doc.result.target_sha}],
    maxRecords:1,
    getTree:sha=>api('/git/trees/'+sha+'?recursive=1'),
    getBlob:readGitBlob,
    getOriginalStoreBytes,
    getRun:id=>api('/actions/runs/'+id),
    getArtifacts:id=>api('/actions/runs/'+id+'/artifacts?per_page=100'),
    getArtifactZip:originalZip,
    getPull:id=>api('/pulls/'+id),
    getCompare:(writer,current)=>api('/compare/'+writer+'...'+current),
    getCurrentRef:async()=>{
      const current=await api('/git/ref/heads/agent-store');
      return {state:'present',sha:current?.object?.sha};
    }
  });
  if(verified.status!=='verified'||verified.records.length!==1){
    return unavailable('Original Qwen Worker, Publisher, PR and Writer sources not jointly attested',
      storeSha);
  }
  const attested=verified.records[0];
  assert.equal(attested.issue,candidate.issue);
  assert.equal(attested.run_id,candidate.runId);
  assert.equal(attested.action_id,candidate.actionId);
  assert.equal(attested.pr_number,doc.implementing_pr.number);
  return {status:'verified',reason:null,storeSha,
    fixture:{issue:candidate.issue,pr:attested.pr_number,sha:attested.pr_head_sha,
      producerPath:candidate.entry.path,runId:candidate.runId,
      actionId:candidate.actionId},
    attested};
}
module.exports={selectNewestQwenProducer,attestLatestQwenProducer,
  preStagedOriginalZip,readPinnedQwenApi,qwenApi:api};
