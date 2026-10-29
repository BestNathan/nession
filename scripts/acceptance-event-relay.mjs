#!/usr/bin/env node
// #2031: optional GitHub App receiver. Shadow mode only: no Actions dispatch.
import {createServer} from 'node:http';
import {sign} from 'node:crypto';
import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DurableInbox,verifyWebhook,attestSource} from './acceptance-event-relay-core.mjs';
import {parsePreMergeIssueNumbers,isOpenAcceptanceIssue} from './requirement-acceptance.mjs';
import {buildAcceptanceContext} from './acceptance-executor.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const fail=reason=>{throw Error('acceptance-event-relay: '+reason)};
const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');

export function appJwt(appId,privateKey,now=Math.floor(Date.now()/1000)){
  if(!positive(Number(appId))||!privateKey)fail('GitHub App identity missing');
  const unsigned=b64({alg:'RS256',typ:'JWT'})+'.'+b64({iat:now-60,exp:now+480,iss:String(appId)});
  return unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url');
}
export async function installationToken({appId,privateKey,installationId,fetcher=fetch}){
  if(!positive(Number(installationId)))fail('invalid App installation ID');
  const response=await fetcher('https://api.github.com/app/installations/'+installationId+'/access_tokens',{
    method:'POST',headers:{Authorization:'Bearer '+appJwt(appId,privateKey),
      Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(15000)});
  if(!response.ok)fail('installation authentication failed HTTP '+response.status);
  const body=await response.json();
  if(typeof body.token!=='string'||body.token.length<20)fail('invalid installation token');
  return body.token;
}
export async function githubGet(path,token,fetcher=fetch){
  if(!/^\/repos\/BestNathan\/nession\/[a-zA-Z0-9/_?=&.%-]+$/.test(path))
    fail('forbidden GitHub path');
  const response=await fetcher('https://api.github.com'+path,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)fail('GitHub read HTTP '+response.status);
  return response.json();
}

export function pendingMergedAgentContext(issue,source){
  if(!isOpenAcceptanceIssue(issue))return null;
  // Reuse the canonical SC plan, stage/method selector and contract digest.
  const ctx=buildAcceptanceContext(issue,'post-merge',{
    targetRef:source.target_sha,runId:source.source_run_id,method:'agent'});
  if(!ctx.criteria.some(c=>!['Pass','N/A'].includes(c.current_result)))return null;
  return {issue:Number(issue.number),contract_digest:ctx.contract_sha256};
}

export async function selectEligibleMergedIssues(source,get){
  if(source.repo!==REPO||source.stage!=='post-merge'||!SHA.test(source.target_sha))
    fail('invalid attested source');
  const prs=await get('/repos/BestNathan/nession/commits/'+source.target_sha+'/pulls?per_page=30');
  if(!Array.isArray(prs)||prs.length>30)fail('unbounded PR discovery');
  const ids=new Set();
  for(const pr of prs){
    if(pr?.base?.ref!=='main'||pr.merged_at==null||
      pr.merge_commit_sha!==source.target_sha||pr.head?.repo?.full_name!==REPO)continue;
    for(const id of parsePreMergeIssueNumbers(pr.body,'BestNathan','nession',pr.title))
      ids.add(id);
  }
  if(ids.size>25)fail('unbounded Issue discovery');
  const tasks=[];
  for(const number of [...ids].sort((a,b)=>a-b)){
    const issue=await get('/repos/BestNathan/nession/issues/'+number);
    const candidate=pendingMergedAgentContext(issue,source);
    if(candidate)tasks.push(candidate);
  }
  return tasks;
}

export async function ingestWorkflowEvent({headers,raw,secret,installationId,get,inbox,now=Date.now()}){
  if(!verifyWebhook(raw,headers['x-hub-signature-256'],secret))fail('invalid webhook HMAC');
  if(headers['x-github-event']!=='workflow_run')return {ignored:'unrelated-event'};
  if(!/^[a-f0-9-]{36}$/i.test(headers['x-github-delivery']??''))fail('invalid delivery ID');
  let payload;
  try{payload=JSON.parse(raw.toString('utf8'))}catch{fail('invalid JSON')}
  if(payload?.repository?.full_name!==REPO||payload?.installation?.id!==Number(installationId))
    fail('untrusted repo or installation');
  if(payload.action!=='completed'||!positive(payload.workflow_run?.id))
    return {ignored:'not-completed'};
  const live=await get('/repos/BestNathan/nession/actions/runs/'+payload.workflow_run.id);
  const source=attestSource(payload,live);
  if(!source)return {ignored:'inapplicable-source'};
  // Success of E2E / Full Regression with a skipped Full job proves nothing.
  if(source.source_path==='.github/workflows/e2e-full-regression.yml'){
    const runs=await get('/repos/BestNathan/nession/actions/runs/'+source.source_run_id+
      '/attempts/'+source.source_attempt+'/jobs?per_page=100');
    if(!Array.isArray(runs?.jobs)||runs.jobs.length>100||
      runs.jobs.filter(j=>j.name==='full'&&j.run_id===source.source_run_id&&
        j.run_attempt===source.source_attempt&&j.status==='completed'&&
        j.conclusion==='success').length!==1)
      return {ignored:'full-job-not-executed'};
  }
  const eligible=await selectEligibleMergedIssues(source,get);
  const stored=inbox.record(headers['x-github-delivery'],raw,source,eligible,now);
  return {...stored,eligible:eligible.length,source_run_id:source.source_run_id,mode:'shadow'};
}

export function createRelay(env=process.env,fetcher=fetch){
  if(env.ACCEPTANCE_RELAY_MODE!=='shadow')
    fail('live dispatch is not implemented; shadow-only safety boundary');
  if(!env.ACCEPTANCE_RELAY_DB||!isAbsolute(env.ACCEPTANCE_RELAY_DB)||
    typeof env.ACCEPTANCE_WEBHOOK_SECRET!=='string'||env.ACCEPTANCE_WEBHOOK_SECRET.length<32||
    !env.GITHUB_APP_PRIVATE_KEY||!positive(Number(env.GITHUB_APP_ID))||
    !positive(Number(env.GITHUB_APP_INSTALLATION_ID)))
    fail('persistent DB and GitHub App secrets must be configured');
  const port=Number(env.PORT||8080);
  if(!positive(port)||port>65535)fail('invalid listen port');
  const inbox=new DurableInbox(env.ACCEPTANCE_RELAY_DB);
  const server=createServer(async(req,res)=>{
    const reply=(status,data)=>{
      res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify(data));
    };
    if(req.method==='GET'&&req.url==='/healthz')
      return reply(200,{ok:true,mode:'shadow'});
    if(req.method!=='POST'||req.url!=='/github/webhook')
      return reply(404,{error:'not found'});
    const parts=[];let size=0;
    try{
      for await(const chunk of req){
        size+=chunk.length;
        if(size>1048576)fail('webhook body limit exceeded');
        parts.push(chunk);
      }
      const raw=Buffer.concat(parts);
      if(!verifyWebhook(raw,req.headers['x-hub-signature-256'],env.ACCEPTANCE_WEBHOOK_SECRET))
        return reply(401,{error:'invalid signature'});
      const token=await installationToken({appId:env.GITHUB_APP_ID,
        installationId:env.GITHUB_APP_INSTALLATION_ID,
        privateKey:env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g,'\n'),fetcher});
      const result=await ingestWorkflowEvent({headers:req.headers,raw,
        secret:env.ACCEPTANCE_WEBHOOK_SECRET,installationId:env.GITHUB_APP_INSTALLATION_ID,
        get:path=>githubGet(path,token,fetcher),inbox});
      console.log(JSON.stringify({kind:'acceptance_event_shadow',result}));
      return reply(202,result);
    }catch(err){
      // No Issue bodies, tokens, HMACs or credential fields in the log.
      console.error('acceptance-event-relay: webhook delivery not committed',
        err instanceof SyntaxError ? 'invalid-json' : 'processing-error');
      return reply(503,{error:'delivery not committed; redeliver'});
    }
  });
  server.on('close',()=>inbox.close());
  return {server,port,inbox};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server,port}=createRelay();
  server.listen(port,'0.0.0.0',()=>console.log('Acceptance event shadow listening on '+port));
}
