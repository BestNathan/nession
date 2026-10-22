import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProjection, validateProjection } from './project.mjs';
import { WORKFLOW_IDS, projectWorkflowGraph } from './workflow-graph.mjs';
import { loadIssueRunObservations } from './issue-runs.mjs';
import {agentStoreReadiness} from './agent-store-readiness.mjs';
import { loadPinnedE2E } from './acceptance-e2e.mjs';
import {selectScopedE2ERuns,scopedE2EPaths} from './e2e-run-window.mjs';

const repo = 'BestNathan/nession';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = resolve(process.env.PAGES_OUT_DIR || join(root,'dist'));
const metrics = resolve(process.env.METRICS_DIR || join(root,'../metrics-store'));
const acceptance = resolve(process.env.ACCEPTANCE_RESULTS_DIR || join(root,'../acceptance-store'));
const acceptanceSha = process.env.ACCEPTANCE_RESULTS_SHA;
const token = process.env.GITHUB_TOKEN || '';
async function optionalJson(file){
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch { return null; }
}
async function api(path) {
  if (process.env.PAGES_OFFLINE === '1') throw new Error('offline fixture');
  // Build-time, never browser-side. No token or trusted API access is deployed.
  const headers = { 'accept':'application/vnd.github+json', 'x-github-api-version':'2022-11-28', 'user-agent':'nession-pages-projection' };
  if(token) headers.authorization='Bearer '+token;
  const response=await fetch('https://api.github.com/repos/'+repo+path,{headers,signal:AbortSignal.timeout(15000)});
  if(response.status===404)return { missing:true };
  if(!response.ok)throw new Error('GitHub API request failed: HTTP '+response.status);
  return response.json();
}
async function optionalList(path) {
  try {
    const data=await api(path);
    return Array.isArray(data)?data:null;
  } catch (e) { console.error('Optional GitHub listing unavailable:',path,e.message);return null; }
}
async function optionalIssueTimelines(sourceIssues){
  if(!Array.isArray(sourceIssues))return null;
  // Match the public Pages Issue window, never enumerate all private/old Issues.
  const selected=sourceIssues.filter(x=>Number.isSafeInteger(x?.number)&&x.number>0&&!x.pull_request)
    .sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||''))||a.number-b.number)
    .slice(0,12);
  const entries=await Promise.all(selected.map(async issue=>{
    try{
      const events=await api('/issues/'+issue.number+'/timeline?per_page=100');
      return [String(issue.number),Array.isArray(events)
        ? {status:events.length>=100?'truncated':'available',events:events.slice(0,100)}
        : {status:'unavailable',events:[]}];
    }catch(err){
      console.error('Optional Issue Timeline unavailable:',issue.number,err.message);
      return [String(issue.number),{status:'unavailable',events:[]}];
    }
  }));
  return Object.fromEntries(entries);
}
async function optionalPrReviews(sourcePulls){
  if(!Array.isArray(sourcePulls))return null;
  // Only the same 12 most recently updated public PRs shown in the projection.
  const selected=sourcePulls.filter(x=>Number.isSafeInteger(x?.number)&&x.number>0)
    .sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||''))||a.number-b.number)
    .slice(0,12);
  const entries=await Promise.all(selected.map(async pr=>{
    try{
      const items=await api('/pulls/'+pr.number+'/reviews?per_page=100');
      return [String(pr.number),Array.isArray(items)
        ? {status:items.length>=100?'truncated':'available',items:items.slice(0,100)}
        : {status:'unavailable',items:[]}];
    }catch(err){
      console.error('Optional PR reviews unavailable:',pr.number,err.message);
      return [String(pr.number),{status:'unavailable',items:[]}];
    }
  }));
  return Object.fromEntries(entries);
}
async function optionalRuns(){
  try{
    const result=await api('/actions/runs?per_page=100');
    return Array.isArray(result?.workflow_runs)?result.workflow_runs:null;
  }catch(error){console.error('Public CI Run snapshot unavailable:',error.message);return null;}
}
async function optionalScopedE2ERuns(){
  const responses=await Promise.all(scopedE2EPaths.map(async path=>{
    try { return await api('/actions/workflows/'+path.split('/').at(-1)+'/runs?per_page=100'); }
    catch(error){
      console.error('Optional trusted E2E Run window unavailable:',path,error.message);
      return null;
    }
  }));
  const scoped=selectScopedE2ERuns(responses);
  if(!scoped)console.error('Independent E2E/Test Ingest Run identity window unavailable');
  return scoped;
}
async function optionalRef(branch) {
  try {
    const result=await api('/git/ref/heads/'+encodeURIComponent(branch));
    if(result?.missing)return {state:'missing'};
    return {state:'present',sha:result?.object?.sha};
  } catch(e){console.error('Optional ref unavailable:',branch,e.message);return {state:'unavailable'};}
}
const [repository,agent,registry,issues,pulls,workflowRuns,allRefs] = await Promise.all([
  optionalJson(join(metrics,'metrics.json')),
  optionalJson(join(metrics,'agent-metrics.json')),
  optionalJson(join(root,'../automation/agents/registry.json')),
  optionalList('/issues?state=open&sort=updated&direction=desc&per_page=100'),
  optionalList('/pulls?state=open&sort=updated&direction=desc&per_page=100'),
  optionalRuns(),
  Promise.all(['metrics','acceptance-results','task-results','agent-store'].map(optionalRef))
]);
// Pin the public Git tree to the exact original ref SHA, then re-read that
// ref before classification. This is source-readiness ONLY (not writer trust).
async function optionalAgentStoreReadiness(ref) {
  if(ref?.state==='missing')return agentStoreReadiness(ref,null,null);
  if(ref?.state!=='present')return agentStoreReadiness(ref,null,null);
  try {
    if(!/^[a-f0-9]{40}$/.test(ref.sha||''))return agentStoreReadiness(ref,null,null);
    const entries=await api('/contents?ref='+ref.sha);
    const again=await optionalRef('agent-store');
    return agentStoreReadiness(ref,entries,again);
  } catch (error) {
    console.error('Pinned agent-store source unavailable:',error.message);
    return agentStoreReadiness(ref,null,null);
  }
}
const agentStoreSource=await optionalAgentStoreReadiness(allRefs[3]);
const generatedAt=new Date().toISOString();
const selectedIssueNumbers=Array.isArray(issues)?issues
  .filter(x=>Number.isSafeInteger(x?.number)&&x.number>0&&!x.pull_request)
  .sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||''))||a.number-b.number)
  .slice(0,12).map(x=>x.number):[];
const [issueTimelines,prReviews,issueRunSource,scopedE2ERuns]=await Promise.all([
  optionalIssueTimelines(issues),optionalPrReviews(pulls),
  loadIssueRunObservations({root:metrics,expectedSha:process.env.METRICS_SHA,
    issues:selectedIssueNumbers,at:generatedAt}),
  optionalScopedE2ERuns(),
]);
const acceptanceE2E=await loadPinnedE2E({root:acceptance,expectedSha:acceptanceSha,
  prHeads:Array.isArray(pulls)?pulls.slice(0,12).map(x=>x.head?.sha).filter(Boolean):[],
  workflowRuns:scopedE2ERuns?.runs??null,
  runWindowTruncated:scopedE2ERuns?.truncated??false,at:generatedAt});
const refs=Object.fromEntries(['metrics','acceptance-results','task-results','agent-store'].map((name,index)=>[name,allRefs[index]]));
const result=validateProjection(makeProjection({
  repository,agent,registry,issues,pulls,workflowRuns,issueTimelines,prReviews,
  issueRunSource,acceptanceE2E,agentStoreSource,refs,
  meta:{ generated_at:generatedAt,main_sha:process.env.SOURCE_MAIN_SHA,metrics_sha:process.env.METRICS_SHA,
    acceptance_results_sha:acceptanceSha }
}));
// The topology is derived from exact checked-in YAML definitions, not the mutable
// Actions API, a guessed diagram, or evidence of successful execution.
const yamlFiles=await Promise.all(WORKFLOW_IDS.map(async id=>
  [id,await readFile(join(root,'../.github/workflows',id+'.yml'),'utf8')]));
const workflowGraph=projectWorkflowGraph(Object.fromEntries(yamlFiles),
  /^[a-f0-9]{40}$/.test(process.env.SOURCE_MAIN_SHA||'')?process.env.SOURCE_MAIN_SHA:null,
  generatedAt);
await mkdir(join(out,'data'),{recursive:true});
for(const name of ['index.html','styles.css','app.js','favicon.svg','workflows.html','workflows.js','workflows.css']) await copyFile(join(root,name),join(out,name));
await writeFile(join(out,'data/site.json'),JSON.stringify(result,null,2)+'\n',{mode:0o644});
await writeFile(join(out,'data/workflows.json'),JSON.stringify(workflowGraph,null,2)+'\n',{mode:0o644});
console.log('Public Pages artifact:',out);
console.log(JSON.stringify({
  source_main_sha:result.source.main_sha,
  metrics_sha:result.source.metrics_sha,
  repository:result.repository.available, agents:result.agents.available,
  issues:result.work.issues_status,pulls:result.work.pulls_status,
  agent_run_observation:result.work.agent_run_source,
  acceptance_e2e:result.work.acceptance_e2e.status,
  published_e2e_ids:result.work.acceptance_e2e.records.length,
  lineage_status:result.work.lineage.status,
  agent_store_readiness:result.work.agent_store_readiness.status,
  stores:result.evidence.stores.map(x=>[x.name,x.state])
}));
