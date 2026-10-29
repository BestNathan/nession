#!/usr/bin/env node
// GitHub does not automatically redeliver failed App webhooks.
// Recover missed signed notifications without creating GitHub Actions Runs.
import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DurableInbox} from './acceptance-event-relay-core.mjs';
import {appJwt,installationToken} from './acceptance-event-relay.mjs';

const REPO='BestNathan/nession';
const API='https://api.github.com';
const positive=n=>Number.isSafeInteger(n)&&n>0;
const THREE_DAYS=3*24*60*60*1000;
const fail=s=>{throw Error('acceptance-webhook-recovery: '+s)};
const headers=jwt=>({Authorization:'Bearer '+jwt,
  Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'});
const success=row=>(row.status==='OK'||Number.isInteger(row.status_code)&&
  row.status_code>=200&&row.status_code<400);

export function selectFailedAppDeliveries(deliveries,{repositoryId,installationId,now=Date.now()}){
  if(!positive(repositoryId)||!positive(installationId)||
    !Number.isSafeInteger(now)||!Array.isArray(deliveries))fail('invalid scope');
  const byGuid=new Map();
  for(const row of deliveries){
    if(row?.repository_id!==repositoryId||row.installation_id!==installationId||
      row.event!=='workflow_run'||row.action!=='completed')continue;
    if(!positive(row.id)||!/^[0-9a-f-]{36}$/i.test(row.guid??'')||
      !Number.isFinite(Date.parse(row.delivered_at??'')))
      fail('malformed relevant GitHub App delivery');
    const timestamp=Date.parse(row.delivered_at);
    if(timestamp<now-THREE_DAYS||timestamp>now+60000)continue;
    let item=byGuid.get(row.guid);
    if(!item){item={guid:row.guid,successful:false,failedId:null,latest:-Infinity};
      byGuid.set(row.guid,item);}
    if(success(row))item.successful=true;
    else if(timestamp>=item.latest){item.latest=timestamp;item.failedId=row.id;}
  }
  return [...byGuid.values()].filter(x=>!x.successful&&x.failedId!==null)
    .sort((a,b)=>a.guid.localeCompare(b.guid));
}
export async function listAppDeliveries(jwt,fetcher=fetch,{
  now=Date.now(),maxPages=20,
}={}){
  if(typeof jwt!=='string'||!jwt||!Number.isSafeInteger(now)||
    !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>50)fail('invalid audit arguments');
  let url=API+'/app/hook/deliveries?per_page=100';
  let rows=[];
  for(let page=0;page<maxPages;page++){
    const response=await fetcher(url,{
      method:'GET',headers:headers(jwt),signal:AbortSignal.timeout(15000)});
    if(!response.ok)fail('App delivery list rejected HTTP '+response.status);
    const data=await response.json();
    if(!Array.isArray(data)||data.length>100)fail('invalid App delivery page');
    rows.push(...data);
    // The App endpoint is newest first. Stop when the current page reaches
    // beyond GitHub's three-day redelivery horizon.
    const dated=data.filter(x=>Number.isFinite(Date.parse(x?.delivered_at??'')));
    if(dated.some(x=>Date.parse(x.delivered_at)<now-THREE_DAYS))return rows;
    const link=response.headers?.get?.('link')??'';
    const next=link.split(',').find(p=>/;\s*rel="next"/.test(p));
    if(!next)return rows;
    const match=next.match(/<([^>]+)>/);
    if(!match)fail('invalid App delivery pagination');
    const parsed=new URL(match[1]);
    if(parsed.origin!==API||parsed.pathname!=='/app/hook/deliveries'||
      !parsed.searchParams.has('cursor'))fail('untrusted App delivery cursor');
    url=parsed.toString();
  }
  fail('App delivery scan exceeded bounded pagination');
}
export async function requestAppRedelivery(jwt,deliveryId,fetcher=fetch){
  if(!positive(deliveryId))fail('invalid delivery ID');
  const response=await fetcher(API+'/app/hook/deliveries/'+deliveryId+'/attempts',{
    method:'POST',headers:headers(jwt),signal:AbortSignal.timeout(15000)});
  // 202 is only "a new delivery was scheduled", not an endpoint ACK.
  return response.status===202;
}
export async function auditFailedAppDeliveries(inbox,{
  repositoryId,installationId,jwt,fetcher=fetch,now=Date.now(),
}){
  const rows=await listAppDeliveries(jwt,fetcher,{now});
  const missed=selectFailedAppDeliveries(rows,{repositoryId,installationId,now});
  let requested=0,reserved=0;
  for(const row of missed){
    // Atomic reservation before POST: a crash or timeout may have sent the
    // request. Never blindly issue the same redelivery immediately.
    if(!inbox.reserveWebhookRedelivery(row.guid,row.failedId,now,3600000))continue;
    reserved++;
    try{
      const accepted=await requestAppRedelivery(jwt,row.failedId,fetcher);
      inbox.recordWebhookRedeliveryOutcome(row.guid,accepted?'accepted':'uncertain');
      if(accepted)requested++;
    }catch{
      inbox.recordWebhookRedeliveryOutcome(row.guid,'uncertain');
    }
  }
  return {scanned:rows.length,failed_guids:missed.length,
    reserved,requested,mode:'webhook-recovery'};
}
export function createWebhookRecovery(env=process.env,fetcher=fetch){
  if(env.ACCEPTANCE_WEBHOOK_RECOVERY_MODE!=='enabled')
    fail('explicit App webhook audit opt-in required');
  if(!isAbsolute(env.ACCEPTANCE_RELAY_DB??'')||
    !positive(Number(env.GITHUB_APP_ID))||
    !positive(Number(env.GITHUB_APP_INSTALLATION_ID))||
    !env.GITHUB_APP_PRIVATE_KEY)fail('durable DB and App owner credentials required');
  const inbox=new DurableInbox(env.ACCEPTANCE_RELAY_DB);
  const pem=env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g,'\n');
  let stopped=false,inFlight=null,timer=null;
  async function execute(){
    if(stopped||inFlight)return;
    inFlight=(async()=>{
      const token=await installationToken({appId:env.GITHUB_APP_ID,
        installationId:env.GITHUB_APP_INSTALLATION_ID,privateKey:pem,fetcher});
      const response=await fetcher(API+'/repos/'+REPO,{
        method:'GET',headers:headers(token),signal:AbortSignal.timeout(15000)});
      if(!response.ok)fail('cannot authenticate repository identity');
      const repo=await response.json();
      if(repo?.full_name!==REPO||!positive(repo.id))
        fail('untrusted repository ID');
      return auditFailedAppDeliveries(inbox,{
        repositoryId:repo.id,installationId:Number(env.GITHUB_APP_INSTALLATION_ID),
        jwt:appJwt(env.GITHUB_APP_ID,pem),fetcher});
    })();
    try{
      const result=await inFlight;
      console.log('acceptance-webhook-recovery:',JSON.stringify(result));
    }catch{
      console.error('acceptance-webhook-recovery: audit not complete; no claims of success');
    }finally{inFlight=null;}
  }
  // This audits the GitHub App delivery ledger, not Actions workflows. It
  // needs to be a long-lived independently supervised process; if off for
  // longer than GitHub's retention period, manual backfill is required.
  timer=setInterval(()=>void execute(),600000);
  void execute();
  return {inbox,stop:async()=>{
    stopped=true;clearInterval(timer);
    if(inFlight)await inFlight;
    inbox.close();
  }};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const worker=createWebhookRecovery();
  process.on('SIGINT',()=>void worker.stop());
  process.on('SIGTERM',()=>void worker.stop());
}
