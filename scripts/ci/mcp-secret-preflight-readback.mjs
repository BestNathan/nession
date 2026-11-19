#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
// #3914 main-owned read-only observation. Never print raw Pod/Secret JSON.
export const JOB='nession-mcp-secret-preflight-3914';
const refs={MCP_INBOUND:['nession-mcp-inbound-staging','token'],
  MCP_BACKEND:['nession-mcp-backend-server-staging','token'],
  SERVER_AUTH:['nession-secret-staging','auth-token']};
const reason={21:'inbound_empty',22:'backend_empty',23:'server_empty',
  24:'inbound_equals_backend',25:'backend_server_mismatch'};
const v=(status,why)=>({status,why});
export function classify(x){
  if(x?.kind!=='PodList'||!Array.isArray(x.items))return v('fail','invalid_pod_list');
  if(x.items.length===0)return v('pending','pod_not_created');
  if(x.items.length!==1)return v('fail','unexpected_pod_count');
  const p=x.items[0],m=p?.metadata||{},s=p?.spec||{};
  if(m.namespace!=='nession'||m.labels?.['batch.kubernetes.io/job-name']!==JOB||
      m.labels?.component!=='mcp-secret-preflight'||
      !m.ownerReferences?.some(o=>o.kind==='Job'&&o.name===JOB&&o.controller===true))
    return v('fail','pod_identity_mismatch');
  const c=s.containers||[];
  if(c.length!==1||c[0].name!=='verify'||s.automountServiceAccountToken!==false||
      s.securityContext?.runAsNonRoot!==true)return v('fail','pod_security_mismatch');
  const env=c[0].env||[];
  if(env.length!==3)return v('fail','secret_ref_mismatch');
  for(const [name,[secret,key]]of Object.entries(refs)){
    const matches=env.filter(e=>e.name===name),e=matches[0],r=e?.valueFrom?.secretKeyRef;
    if(matches.length!==1||Object.hasOwn(e,'value')||
       r?.name!==secret||r?.key!==key||r?.optional!==false)
      return v('fail','secret_ref_mismatch');
  }
  const status=p.status||{},st=(status.containerStatuses||[]).find(t=>t.name==='verify')?.state||{};
  if(st.terminated)return status.phase==='Succeeded'&&st.terminated.exitCode===0?
      v('pass','secrets_consumed_and_backend_matched_server'):
      v('fail',reason[st.terminated.exitCode]||'probe_failed');
  if(['CreateContainerConfigError','CreateContainerError','ErrImagePull',
      'ImagePullBackOff','InvalidImageName'].includes(st.waiting?.reason))
    return v('fail','startup_'+st.waiting.reason);
  if(['Succeeded','Failed'].includes(status.phase))return v('fail','terminal_state_invalid');
  return v('pending','probe_not_finished');
}
function selftest(){
  const env=Object.entries(refs).map(([name,[secret,key]])=>({
    name,valueFrom:{secretKeyRef:{name:secret,key,optional:false}}}));
  const pod={metadata:{namespace:'nession',labels:{
    'batch.kubernetes.io/job-name':JOB,component:'mcp-secret-preflight'},
    ownerReferences:[{name:JOB,kind:'Job',controller:true}]},
    spec:{automountServiceAccountToken:false,securityContext:{runAsNonRoot:true},
      containers:[{name:'verify',env}]},
    status:{phase:'Succeeded',containerStatuses:[{name:'verify',
      state:{terminated:{exitCode:0}}}]}};
  const list=p=>({kind:'PodList',items:[p]});
  const cp=()=>structuredClone(pod);
  assert.equal(classify(list(pod)).status,'pass');
  assert.equal(classify({kind:'PodList',items:[]}).status,'pending');
  assert.equal(classify({kind:'PodList',items:[pod,pod]}).status,'fail');
  let q=cp();q.metadata.ownerReferences[0].name='foreign';
  assert.equal(classify(list(q)).why,'pod_identity_mismatch');
  q=cp();q.spec.containers[0].env[0]={name:'MCP_INBOUND',value:'NEVER_LOG_THIS_TOKEN'};
  assert.equal(classify(list(q)).why,'secret_ref_mismatch');
  assert.ok(!JSON.stringify(classify(list(q))).includes('NEVER_LOG_THIS_TOKEN'));
  q=cp();q.status.phase='Failed';q.status.containerStatuses[0].state.terminated.exitCode=25;
  assert.equal(classify(list(q)).why,'backend_server_mismatch');
  q=cp();q.status.phase='Pending';q.status.containerStatuses[0].state={
    waiting:{reason:'CreateContainerConfigError',message:'NEVER_LOG_THIS_MESSAGE'}};
  assert.equal(classify(list(q)).why,'startup_CreateContainerConfigError');
  assert.ok(!JSON.stringify(classify(list(q))).includes('NEVER_LOG_THIS_MESSAGE'));
  console.log('mcp-secret-preflight classifier positive, identity, missing and leak negatives passed');
}
if(process.argv[2]==='self-test')selftest();
else if(process.argv[2]==='evaluate'){
  try{
    if(process.argv.length!==4)throw Error('invalid argc');
    const result=classify(JSON.parse(fs.readFileSync(process.argv[3],'utf8')));
    console.log(result.status+':'+result.why);
  }catch{console.log('fail:pod_readback_unparseable');process.exitCode=1;}
}else{console.error('usage: self-test|evaluate POD_LIST_JSON');process.exitCode=2;}
