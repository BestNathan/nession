#!/usr/bin/env node
// #2010. UNTRUSTED Worker claim. No HMAC key or Git Writer needed. Only an
// independently authenticated workflow_run receiver may turn this artifact
// into a Run-bound Store receipt.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const REPO='BestNathan/nession',HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
function fail(x){throw Error('Agent Worker claim: '+x);}
export function createWorkerClaim(input,context){
  // GitHub may expose an omitted optional workflow_dispatch input as "".
  // Normalize only that empty optional field, not any signed identity.
  if(input&&typeof input==='object'&&!Array.isArray(input)&&input.resume_from===''){
    input={...input};delete input.resume_from;
  }
  const fields=['action_id','issue_number','agent_id','task','input_sha',
    'dispatch_ticket','resume_from'];
  const positive=n=>Number.isSafeInteger(n)&&n>0;
  if(!input||typeof input!=='object'||Array.isArray(input)||
      Object.keys(input).length<6||Object.keys(input).length>7||
      Object.keys(input).some(k=>!fields.includes(k))||
      !HEX64.test(input.action_id??'')||
      !/^[1-9]\d*$/.test(input.issue_number??'')||
      !/^[a-z][a-z0-9-]*$/.test(input.agent_id??'')||
      !['implement','repair'].includes(input.task)||
      !HEX40.test(input.input_sha??'')||
      typeof input.dispatch_ticket!=='string'||input.dispatch_ticket.length>1800||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.dispatch_ticket)||
      (input.resume_from!=null&&!/^[A-Za-z0-9_-]{1,600}$/.test(input.resume_from))||
      context.repository!==REPO||context.ref!=='refs/heads/main'||
      context.event!=='workflow_dispatch'||context.workflow!=='Agent / Development'||
      context.actor!=='BestNathan'||!HEX40.test(context.head_sha??'')||
      !positive(context.run_id)||!positive(context.attempt))
    fail('invalid Developer claim identity or workflow context');
  return {schema_version:1,kind:'agent_developer_claim',repository:REPO,
    workflow_path:'.github/workflows/agent-develop.yml',
    workflow_name:'Agent / Development',
    source:{run_id:context.run_id,attempt:context.attempt,head_sha:context.head_sha,
      actor:context.actor,ref:context.ref,event:context.event},
    inputs:input};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{
    if(process.argv[2]!=='prepare'||process.argv.length!==4||
        process.env.GITHUB_ACTIONS!=='true')fail('trusted GitHub Worker context required');
    const inputs=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')).inputs;
    const claim=createWorkerClaim(inputs,{
      repository:process.env.GITHUB_REPOSITORY,ref:process.env.GITHUB_REF,
      event:process.env.GITHUB_EVENT_NAME,workflow:process.env.GITHUB_WORKFLOW,
      actor:process.env.GITHUB_ACTOR,head_sha:process.env.GITHUB_SHA,
      run_id:Number(process.env.GITHUB_RUN_ID),
      attempt:Number(process.env.GITHUB_RUN_ATTEMPT)});
    fs.writeFileSync(process.argv[3],JSON.stringify(claim,null,2)+'\n',
      {flag:'wx',mode:0o600});
    console.log('Untrusted Developer claim published; no Store receipt or model permission granted');
  }catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
