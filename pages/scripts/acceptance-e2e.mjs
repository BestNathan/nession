// Bounded, read-only, Git-SHA-pinned E2E evidence from the canonical
// acceptance-results orphan checkout. These records certify *executed tests*,
// NEVER an individual Acceptance SC or implementing Issue/PR ownership.
import {lstat,readdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const validId=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9_-]{0,70}$/.test(s);
const wfPath=x=>x?.path?.replace(/@refs\/heads\/[^\s]+$/,'');
async function directory(path){
 const st=await lstat(path);
 if(st.isSymbolicLink()||!st.isDirectory())throw Error('untrusted E2E directory');
 return path;
}
async function fileJson(path,max=65536){
 const st=await lstat(path);
 if(st.isSymbolicLink()||!st.isFile()||st.size<2||st.size>max)
   throw Error('unsafe E2E source file');
 const data=await readFile(path);
 return {value:JSON.parse(data.toString('utf8')),
   digest:createHash('sha256').update(data).digest('hex')};
}
function actionsRun(r,id,attempt,sha){
 return r?.id===id&&r.run_attempt===attempt&&r.head_sha===sha&&
   r.name==='E2E / Tests'&&wfPath(r)==='.github/workflows/e2e-tests.yml'&&
   r.event==='pull_request'&&r.repository?.full_name===REPO&&
   r.head_repository?.full_name===REPO&&r.status==='completed'&&r.conclusion==='success';
}
function ingestRun(r,id,attempt){
 return r?.id===id&&r.run_attempt===attempt&&
   r.name==='E2E / Test Ingest'&&r.repository?.full_name===REPO&&
   r.status==='completed'&&r.conclusion==='success'&&
   r.event==='workflow_run';
}
function recordProof(raw,projections,prHeads,runList){
 if(raw?.schema_version!==1||raw.kind!=='issue_e2e_run'||!SHA.test(raw.target_sha??'')||
    !positive(raw.run_id)||!positive(raw.run_attempt)||
    !HASH.test(raw.plan_digest??'')||
    !/^sha256:[a-f0-9]{64}$/.test(raw.artifact_digest??'')||
    !Array.isArray(raw.results)||raw.results.length>100)throw Error('untrusted E2E run record');
 if(!prHeads.includes(raw.target_sha))return null;
 if(!runList.some(r=>actionsRun(r,raw.run_id,raw.run_attempt,raw.target_sha)))
   return null; // No independent exact-SHA workflow proof in bounded window.
 const ids=new Map();
 for(const entry of raw.results){
   if(!validId(entry?.id)||!['Pass','Fail','Pending','Error'].includes(entry?.result)||
      !Number.isSafeInteger(entry.discovered)||entry.discovered<0||
      !Number.isSafeInteger(entry.passed)||entry.passed<0||
      !Number.isSafeInteger(entry.failed)||entry.failed<0||
      !Number.isSafeInteger(entry.skipped)||entry.skipped<0||
      !Number.isSafeInteger(entry.flaky)||entry.flaky<0||
      ids.has(entry.id))throw Error('invalid or duplicate E2E result');
   if(entry.result==='Pass' && (entry.discovered<1||
      entry.passed!==entry.discovered||entry.failed!==0||entry.skipped!==0||entry.flaky!==0))
     throw Error('forged E2E Pass counters');
   ids.set(entry.id,entry);
 }
 const matched=projections.filter(x=>x?.schema_version===1&&
   x.kind==='issue_e2e_projection_receipt'&&x.outcome==='applied'&&
   positive(x.issue)&&x.run_id===raw.run_id&&x.run_attempt===raw.run_attempt&&
   x.target_sha===raw.target_sha&&x.plan_digest===raw.plan_digest&&
   x.artifact_digest===raw.artifact_digest&&positive(x.ingest_run_id)&&
   positive(x.ingest_attempt)&&Array.isArray(x.rows)&&x.rows.length<=100&&
   runList.some(r=>ingestRun(r,x.ingest_run_id,x.ingest_attempt)));
 const byTest=new Map();
 for(const x of matched){
   for(const row of x.rows){
     const src=ids.get(row?.id);
     if(!src||row.result!==src.result||
        (row.result==='Pass'&&!String(row.evidence||'').includes('run '+raw.run_id+'/'+raw.run_attempt)))
       throw Error('untrusted source E2E projected result');
     const key=x.issue+':'+row.id;
     if(byTest.has(key))throw Error('ambiguous E2E projection record');
     byTest.set(key,{issue:x.issue,id:row.id,result:row.result,
       run_id:raw.run_id,attempt:raw.run_attempt,target_sha:raw.target_sha,
       url:'https://github.com/'+REPO+'/actions/runs/'+raw.run_id});
   }
 }
 return [...byTest.values()].sort((a,b)=>a.issue-b.issue||a.id.localeCompare(b.id));
}
export async function loadPinnedE2E({root,expectedSha,prHeads,workflowRuns,at,maxDirs=110}){
 const unavailable={status:'unavailable',source_sha:null,records:[]};
 if(!SHA.test(expectedSha??'')||!Array.isArray(prHeads)||prHeads.length>12||
    prHeads.some(s=>!SHA.test(s))||!Array.isArray(workflowRuns)||
    !Number.isSafeInteger(maxDirs)||maxDirs<1||maxDirs>300||
    typeof at!=='string'||!Number.isFinite(Date.parse(at)))return unavailable;
 try{
   const path=resolve(root);
   await directory(path);
   const sha=execFileSync('git',['-C',path,'rev-parse','HEAD'],
     {encoding:'utf8',timeout:5000}).trim();
   if(sha!==expectedSha)throw Error('pinned E2E Store SHA drift');
   const dirty=execFileSync('git',['-C',path,'status','--porcelain','--untracked-files=all',
     '--','runs'],{encoding:'utf8',timeout:5000}).trim();
   if(dirty)throw Error('dirty E2E result store');
   const base=await directory(join(path,'runs'));
   const days=Array.from({length:7},(_,i)=>
     new Date(Date.parse(at)-i*86400000).toISOString().slice(0,10));
   let seen=0,truncated=false;const records=[],identity=new Set(),covered=new Set();
   outer:for(const day of days){
     let dayPath;
     try{dayPath=await directory(join(base,day));}
     catch(err){if(err.code==='ENOENT')continue;throw err;}
     const entries=(await readdir(dayPath,{withFileTypes:true}))
       .sort((a,b)=>b.name.localeCompare(a.name));
     for(const entry of entries){
       if(!/^[1-9][0-9]*-[1-9][0-9]*$/.test(entry.name)||!entry.isDirectory()||
          entry.isSymbolicLink())throw Error('unsafe E2E run entry');
       if(seen++>=maxDirs){truncated=true;break outer;}
       const [runId,attempt]=entry.name.split('-').map(Number);
       const runDir=await directory(join(dayPath,entry.name));
       const testDir=join(runDir,'test');
       try{await directory(testDir);}catch(err){
         if(err.code==='ENOENT')continue;throw err;}
       const primary=join(testDir,'issue-e2e.json');
       let raw;
       try{raw=(await fileJson(primary)).value;}catch(err){
         if(err.code==='ENOENT')continue;throw err;}
       if(raw.run_id!==runId||raw.run_attempt!==attempt)
         throw Error('inconsistent E2E source path');
       // Do not let an unrelated old Issue/PR or oversized readback poison
       // the selected exact-head evidence window.
       if(!prHeads.includes(raw.target_sha))continue;
       const projectionPath=join(testDir,'projections');
       const projections=[];
       try{
         await directory(projectionPath);
         const names=(await readdir(projectionPath,{withFileTypes:true}))
           .sort((a,b)=>a.name.localeCompare(b.name));
         if(names.length>30)throw Error('unbounded E2E projection');
         for(const row of names){
           if(!/^[1-9][0-9]*\.json$/.test(row.name)||!row.isFile()||
              row.isSymbolicLink())throw Error('untrusted E2E projection path');
           projections.push((await fileJson(join(projectionPath,row.name),110000)).value);
         }
       }catch(err){if(err.code!=='ENOENT')throw err;}
       const proof=recordProof(raw,projections,prHeads,workflowRuns.slice(0,100));
       if(!proof)continue;
       for(const r of proof){
         const id=r.issue+':'+r.id+':'+r.run_id+':'+r.attempt;
         if(identity.has(id))throw Error('duplicate authenticated E2E record');
         identity.add(id);records.push(r);covered.add(r.issue);
       }
     }
   }
   records.sort((a,b)=>a.issue-b.issue||a.id.localeCompare(b.id)||
     b.run_id-a.run_id||b.attempt-a.attempt);
   if(records.length>24)truncated=true;
   return {status:truncated?'truncated':'available',source_sha:expectedSha,
     records:records.slice(0,24)};
 }catch{return unavailable;} // Source failure can never become a Pass.
}
export function validatePublicE2E(source){
 if(!source||!['available','truncated','unavailable'].includes(source.status)||
    (source.source_sha!==null&&!SHA.test(source.source_sha))||
    !Array.isArray(source.records)||source.records.length>24||
    (source.status==='unavailable'&&(source.records.length||source.source_sha!==null)))
   throw Error('invalid public E2E source');
 for(const x of source.records){
   if(!x||Object.keys(x).some(k=>!['issue','id','result','run_id','attempt','target_sha','url'].includes(k))||
     !positive(x.issue)||!validId(x.id)||!['Pass','Fail','Pending','Error'].includes(x.result)||
     !positive(x.run_id)||!positive(x.attempt)||!SHA.test(x.target_sha??'')||
     x.url!=='https://github.com/'+REPO+'/actions/runs/'+x.run_id)
    throw Error('unsafe public E2E proof');
 }
 return source;
}
