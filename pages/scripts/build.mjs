import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProjection, validateProjection } from './project.mjs';

const repo = 'BestNathan/nession';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = resolve(process.env.PAGES_OUT_DIR || join(root,'dist'));
const metrics = resolve(process.env.METRICS_DIR || join(root,'../metrics-store'));
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
const [issueTimelines,prReviews]=await Promise.all([optionalIssueTimelines(issues),optionalPrReviews(pulls)]);
const refs=Object.fromEntries(['metrics','acceptance-results','task-results','agent-store'].map((name,index)=>[name,allRefs[index]]));
const result=validateProjection(makeProjection({
  repository,agent,registry,issues,pulls,workflowRuns,issueTimelines,prReviews,refs,
  meta:{ generated_at:new Date().toISOString(),main_sha:process.env.SOURCE_MAIN_SHA,metrics_sha:process.env.METRICS_SHA }
}));
await mkdir(join(out,'data'),{recursive:true});
for(const name of ['index.html','styles.css','app.js','favicon.svg']) await copyFile(join(root,name),join(out,name));
await writeFile(join(out,'data/site.json'),JSON.stringify(result,null,2)+'\n',{mode:0o644});
console.log('Public Pages artifact:',out);
console.log(JSON.stringify({
  source_main_sha:result.source.main_sha,
  metrics_sha:result.source.metrics_sha,
  repository:result.repository.available, agents:result.agents.available,
  issues:result.work.issues_status,pulls:result.work.pulls_status,
  stores:result.evidence.stores.map(x=>[x.name,x.state])
}));
