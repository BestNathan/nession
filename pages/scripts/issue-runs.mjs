// Read-only, SHA-pinned sampling of existing canonical Agent run summaries.
// This is a public OBSERVATION, never proof of implementing PR or SC Acceptance.
import {readdir, lstat, readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {validateAgentWorkflowTelemetry, telemetryStoragePath} from '../../scripts/agent-workflow-telemetry.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const WORKFLOWS=Object.freeze({
  'issue-audit':{name:'Agent / Issue Audit',path:'.github/workflows/issue-audit.yml',events:['issues','workflow_dispatch']},
  'requirement-acceptance':{names:['Acceptance / Orchestrator','Agent / SC Acceptance'],events:['pull_request_target','push','workflow_run','issues','workflow_dispatch']},
  'agent-provider-smoke':{name:'Agent / Provider Smoke',path:'.github/workflows/agent-provider-smoke.yml',events:['push','workflow_dispatch']},
});
const validPositive=n=>Number.isSafeInteger(n)&&n>0;
const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const date=s=>typeof s==='string'&&!Number.isNaN(Date.parse(s))?new Date(s).toISOString():null;
const value=(s,re)=>typeof s==='string'&&re.test(s)?s:null;
function normalize(row,workflow,day,file,allowed){
  // Unrelated historical workflows cannot invalidate the selected public
  // Issue window; attest all candidate source bytes BEFORE projecting them.
  if(!validPositive(row?.task?.issue)||!allowed.has(row.task.issue))return null;
  validateAgentWorkflowTelemetry(row); // canonical owner; no parallel telemetry schema.
  const identity=row.identity||{}, task=row.task||{}, agent=row.agent||{};
  if(identity.workflow_id!==workflow || !(WORKFLOWS[workflow].names||[WORKFLOWS[workflow].name]).includes(identity.github_workflow) ||
     identity.repository!==REPO||!WORKFLOWS[workflow].events.includes(identity.event)||
     !validPositive(identity.github_run_id)||!validPositive(identity.github_run_attempt)||
     !value(identity.unique_run_name,/^[a-z0-9][a-z0-9._-]{0,119}$/)||
     file!==identity.unique_run_name+'.json'||
     telemetryStoragePath(row)!==['raw','workflows',workflow,day,file].join('/'))throw Error('wrong source identity/path');
  if(!validPositive(task.issue)||!allowed.has(task.issue))return null;
  if(task.target_ref!==null && task.target_ref!==undefined&&!SHA.test(task.target_ref))
    throw Error('untrusted exact target SHA');
  const observed=date(row.timing?.finished_at)||date(row.timing?.started_at);
  if(!observed)throw Error('unknown observation time');
  return {
    issue:task.issue,run_id:identity.github_run_id,attempt:identity.github_run_attempt,
    workflow,github_workflow:identity.github_workflow,event:identity.event,target_sha:value(task.target_ref,SHA),
    role:value(agent.role,/^(developer|reviewer|acceptor|auditor)$/),
    agent_id:value(agent.id,/^[a-z][a-z0-9-]{0,62}$/),
    provider:value(agent.provider,/^[a-z][a-z0-9_-]{0,31}$/),
    tokens_total:count(row.tokens?.total),duration_ms:count(row.timing?.agent_duration_ms),
    observed_at:observed,
  };
}
// Source run identity is checked independently against GitHub's bounded Actions
// listing in the public projector. This reader NEVER marks one as verified.
export async function loadIssueRunObservations({root,expectedSha,issues,at,maxFiles=250}){
  const unavailable={status:'unavailable',records:[]};
  if(!SHA.test(expectedSha??'')||!date(at)||!Array.isArray(issues)||
     !Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>500)return unavailable;
  const allowed=new Set(issues.filter(validPositive).slice(0,12));
  if(!allowed.size)return unavailable;
  try{
    const abs=resolve(root);
    const rootSt=await lstat(abs);
    if(rootSt.isSymbolicLink()||!rootSt.isDirectory())throw Error('untrusted metrics root');
    const sha=execFileSync('git',['-C',abs,'rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim();
    if(sha!==expectedSha)throw Error('metrics revision drift');
    const dirty=execFileSync('git',['-C',abs,'status','--porcelain','--untracked-files=all','--','raw/workflows'],
      {encoding:'utf8',timeout:5000}).trim();
    if(dirty)throw Error('dirty metrics input');
    const rawSt=await lstat(join(abs,'raw'));
    if(rawSt.isSymbolicLink()||!rawSt.isDirectory())throw Error('untrusted raw directory');
    const base=join(abs,'raw','workflows');
    const baseSt=await lstat(base);
    if(baseSt.isSymbolicLink()||!baseSt.isDirectory())throw Error('untrusted metrics hierarchy');
    const dates=Array.from({length:7},(_,i)=>new Date(Date.parse(at)-i*86400000).toISOString().slice(0,10));
    const records=[],keys=new Set();let seen=0,hasSource=false,truncated=false;
    outer: for(const day of dates){
      for(const workflow of Object.keys(WORKFLOWS)){
        const parent=join(base,workflow);
        let folder;
        try{
          const st=await lstat(parent);
          if(st.isSymbolicLink()||!st.isDirectory())throw Error('unsafe workflow directory');
          hasSource=true;
          folder=join(parent,day);
          const ds=await lstat(folder);
          if(ds.isSymbolicLink()||!ds.isDirectory())throw Error('unsafe date directory');
        }catch(error){
          if(error.code==='ENOENT')continue;
          throw error;
        }
        const entries=(await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
        for(const item of entries){
          if(!item.name.endsWith('.json'))continue;
          if(!/^[a-z0-9][a-z0-9._-]{0,119}\.json$/.test(item.name)||!item.isFile()||item.isSymbolicLink())
            throw Error('unsafe Metrics entry');
          if(seen++>=maxFiles){truncated=true;break outer;}
          const file=join(folder,item.name),st=await lstat(file);
          if(!st.isFile()||st.isSymbolicLink()||st.size>32768||st.size===0)throw Error('oversized/nonregular record');
          const row=JSON.parse(await readFile(file,'utf8'));
          const r=normalize(row,workflow,day,item.name,allowed);
          if(!r)continue;
          const key=r.workflow+':'+r.run_id+':'+r.attempt+':'+r.issue;
          if(keys.has(key))throw Error('duplicate canonical Agent Run identity');
          keys.add(key);records.push(r);
        }
      }
    }
    if(!hasSource)return unavailable;
    records.sort((a,b)=>b.observed_at.localeCompare(a.observed_at)||b.run_id-a.run_id||b.attempt-a.attempt);
    return {status:truncated||records.length>80?'truncated':'available',records:records.slice(0,80)};
  }catch{return unavailable;} // Never export partially trusted source bytes.
}
