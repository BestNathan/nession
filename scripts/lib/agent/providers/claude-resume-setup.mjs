#!/usr/bin/env node
// Operator-only one-shot Claude D1 Session encryption key configuration.
// NOT an unprivileged Task Runner, not a GitHub Workflow with admin Secrets.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {generateSetupValues} from './cursor-resume-setup.mjs';

const REPO='BestNathan/nession',ENVIRONMENT='dev-claude-qwen';
function fail(text){throw Error('Claude Resume setup: '+text);}
function gh(args,input){
  try{return execFileSync('gh',args,{input,encoding:'utf8',timeout:30000,
    maxBuffer:1024*1024,stdio:['pipe','pipe','pipe'],
    env:{...process.env,GH_PROMPT_DISABLED:'1'}}).trim();
  }catch(error){fail('GitHub CLI settings operation failed ('+(error.status??'missing auth')+')');}
}
export function applyClaudeResumeKey({values=generateSetupValues(),execute=gh}={}){
  if(process.env.GITHUB_ACTIONS==='true'||process.env.CI==='true')
    fail('private Environment key provisioning requires an authorized local operator');
  if(process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY!==REPO)
    fail('repository mismatch');
  execute(['secret','set','CLAUDE_RESUME_PRIVATE_KEY_B64','--env',ENVIRONMENT,'--repo',REPO],
    values.privateValue);
  execute(['variable','set','CLAUDE_RESUME_PUBLIC_KEY_B64','--repo',REPO,
    '--body',values.publicValue]);
  return {configured:true,repository:REPO,environment:ENVIRONMENT};
}
function selfTest(){
  const observed=[];
  applyClaudeResumeKey({values:{privateValue:'secret-sentinel',publicValue:'public-sentinel'},
    execute:(args,input)=>{observed.push({args,input});}});
  if(observed.length!==2||observed[0].args[0]!=='secret'||
      observed[0].args.includes('--body')||observed[0].input!=='secret-sentinel'||
      observed[1].args[0]!=='variable'||observed[1].args.at(-1)!=='public-sentinel')
    fail('unsafe provisioning identity/order');
  const failed=[];
  let rejected=false;
  try {applyClaudeResumeKey({values:{privateValue:'x',publicValue:'y'},
    execute:(args)=>{failed.push(args[0]);if(args[0]==='secret')throw Error('denied');}});}
  catch{rejected=true;}
  if(!rejected||failed.join(',')!=='secret')fail('must not enable public key after secret failure');
  console.log('Claude D1 setup: operator-only, secret-first and fail-closed fixtures passed');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{
    if(process.argv[2]==='self-test')selfTest();
    else if(process.argv[2]==='--apply'){
      gh(['auth','status','--hostname','github.com']);
      gh(['api','repos/'+REPO+'/environments/'+ENVIRONMENT]);
      applyClaudeResumeKey();
      console.log('Claude native Session RSA keypair configured (secret in dev-claude-qwen, public repository variable).');
      console.log('No private bytes printed or stored in local files.');
    }else fail('usage: self-test | --apply (authorized LOCAL gh CLI only)');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
