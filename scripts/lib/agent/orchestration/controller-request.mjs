#!/usr/bin/env node
// #1664: read-only Controller request -> authenticated source Artifact handoff.
// No Store/App/private key exists in the manually dispatched workflow.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startDevelopment} from './outbox.mjs';
import {decodeResultZip} from './result-artifact.mjs';
const REPO='BestNathan/nession',ISSUE=/^[1-9][0-9]*$/,SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
const WORKFLOW='Acceptance / Agent Controller';
const PATH='.github/workflows/acceptance-agent-controller.yml';
function fail(message){throw Error('Agent Controller request: '+message);}
const positive=x=>Number.isSafeInteger(x)&&x>0;
function fields(obj,keys){
  return obj&&typeof obj==='object'&&!Array.isArray(obj)&&
    Object.keys(obj).length===keys.length&&Object.keys(obj).every(x=>keys.includes(x));
}
function request(input){
  if(!fields(input,['issue_number','input_sha','developer','reviewer','acceptor'])||
      !ISSUE.test(String(input.issue_number??''))||!SHA.test(input.input_sha??'')||
      !['developer','reviewer','acceptor'].every(k=>
        typeof input[k]==='string'&&/^[a-z][a-z0-9-]{1,80}$/.test(input[k])))
    fail('invalid or extra Issue/Agent request fields');
  return {issue:Number(input.issue_number),sha:input.input_sha,
    developer:input.developer,reviewer:input.reviewer,acceptor:input.acceptor};
}
export function buildControllerRequest(input,run,registry){
  const valid=request(input);
  if(!fields(run,['repository','workflow','workflow_path','event','ref','head_sha',
    'run_id','attempt','actor'])||run.repository!==REPO||
    run.workflow!==WORKFLOW||run.workflow_path!==PATH||
    run.event!=='workflow_dispatch'||run.ref!=='refs/heads/main'||
    !SHA.test(run.head_sha??'')||!positive(run.run_id)||!positive(run.attempt)||
    run.actor!=='BestNathan')fail('untrusted Controller request context');
  // Fail before artifact publication if the assigned roles are not registered.
  startDevelopment(registry,valid,{repository:REPO,event:'workflow_dispatch',
    permission:'write',ref:'refs/heads/main',run_id:run.run_id});
  return {schema_version:1,kind:'agent_controller_start_request',request:valid,run};
}
export function verifyControllerRequestSource(run,artifacts,expected){
  if(!fields(expected,['run_id','attempt','head_sha'])||
      !positive(expected.run_id)||!positive(expected.attempt)||
      !SHA.test(expected.head_sha??'')||run?.id!==expected.run_id||
      run.run_attempt!==expected.attempt||run.head_sha!==expected.head_sha||
      run.name!==WORKFLOW||run.path!==PATH||
      run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
      run.actor?.login!=='BestNathan'||run.event!=='workflow_dispatch'||
      run.head_branch!=='main'||run.status!=='completed'||run.conclusion!=='success')
    fail('source Run is not trusted owner main workflow_dispatch');
  const matches=artifacts?.artifacts?.filter(a=>
    a.name==='agent-controller-request-'+expected.run_id+'-'+expected.attempt);
  if(!Array.isArray(matches)||matches.length!==1||
      !positive(matches[0].id)||matches[0].expired!==false||
      !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest??'')||
      matches[0].workflow_run?.id!==expected.run_id||
      matches[0].workflow_run?.head_sha!==expected.head_sha||
      !positive(matches[0].size_in_bytes)||
      matches[0].size_in_bytes>256*1024)
    fail('untrusted or ambiguous Controller request Artifact');
  return {artifact_id:matches[0].id,digest:matches[0].digest};
}
export function inspectControllerRequestZip(zip,digest,run,expected,registry){
  if(!Buffer.isBuffer(zip)||zip.length>256*1024||
      !/^sha256:[a-f0-9]{64}$/.test(digest??'')||
      'sha256:'+createHash('sha256').update(zip).digest('hex')!==digest)
    fail('authenticated Controller ZIP digest mismatch');
  const json=decodeResultZip(zip,'controller-request.json');
  let document;
  try{document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json));}
  catch{fail('malformed Controller request JSON');}
  if(!fields(document,['schema_version','kind','request','run'])||
      document.schema_version!==1||document.kind!=='agent_controller_start_request')
    fail('unexpected Controller request schema');
  const record=buildControllerRequest({
    issue_number:String(document.request?.issue??''),
    input_sha:document.request?.sha,
    developer:document.request?.developer,reviewer:document.request?.reviewer,
    acceptor:document.request?.acceptor,
  },document.run,registry);
  if(JSON.stringify(record)!==JSON.stringify(document)||
      record.run.run_id!==expected.run_id||
      record.run.attempt!==expected.attempt||
      record.run.head_sha!==expected.head_sha||
      record.run.actor!==run.actor?.login)
    fail('Controller Artifact source binding mismatch');
  return record;
}
function read(p,max=256*1024){
  const st=fs.lstatSync(p);
  if(!st.isFile()||st.isSymbolicLink()||st.size>max||st.size<1)
    fail('unsafe Controller input file');
  return fs.readFileSync(p);
}
function sourceContext(){
  const input=JSON.parse(read(process.env.GITHUB_EVENT_PATH,64*1024).toString('utf8')).inputs;
  return {input,run:{repository:process.env.GITHUB_REPOSITORY,
    workflow:process.env.GITHUB_WORKFLOW,workflow_path:PATH,
    event:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF,
    head_sha:process.env.GITHUB_SHA,run_id:Number(process.env.GITHUB_RUN_ID),
    attempt:Number(process.env.GITHUB_RUN_ATTEMPT),
    actor:process.env.GITHUB_ACTOR}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{
    const [command,...args]=process.argv.slice(2);
    const registry=JSON.parse(read('automation/agents/registry.json').toString('utf8'));
    if(command==='prepare'&&args.length===1){
      if(process.env.GITHUB_ACTIONS!=='true')fail('GitHub Actions context required');
      const {input,run}=sourceContext();
      const doc=buildControllerRequest(input,run,registry);
      fs.writeFileSync(args[0],JSON.stringify(doc,null,2)+'\n',{flag:'wx',mode:0o600});
      console.log('Validated read-only Controller request: '+doc.request.issue);
    }else if(command==='verify-source'&&args.length===5){
      const [runFile,artifactsFile,id,attempt,sha]=args;
      const expected={run_id:Number(id),attempt:Number(attempt),head_sha:sha};
      console.log(JSON.stringify(verifyControllerRequestSource(
        JSON.parse(read(runFile).toString('utf8')),
        JSON.parse(read(artifactsFile).toString('utf8')),expected)));
    }else if(command==='consume'&&args.length===6){
      const [zip,digest,runFile,id,attempt,sha]=args;
      const rawRun=JSON.parse(read(runFile).toString('utf8'));
      console.log(JSON.stringify(inspectControllerRequestZip(
        read(zip),digest,rawRun,
        {run_id:Number(id),attempt:Number(attempt),head_sha:sha},registry)));
    }else fail('usage: prepare OUT | verify-source RUN ARTIFACTS ID ATTEMPT SHA | consume ZIP DIGEST RUN ID ATTEMPT SHA');
  }catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
