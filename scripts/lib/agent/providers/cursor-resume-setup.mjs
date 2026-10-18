#!/usr/bin/env node
// Operator-only provisioning for the synthetic D1 two-Run Cursor continuation.
// No private key is written to the repository, an artifact, or stdout.
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO='BestNathan/nession';
function fail(message){ throw new Error('Cursor D1 setup: '+message); }
function gh(args,input) {
  try {
    return execFileSync('gh',args,{
      encoding:'utf8', input, timeout:30000,
      maxBuffer:1024*1024, stdio:['pipe','pipe','pipe'],
      env:{...process.env,GH_PROMPT_DISABLED:'1'},
    }).trim();
  } catch(error) {
    // Never expose gh stderr, args, key contents, or a token-bearing environment.
    fail('GitHub CLI operation failed (' + (error.status ?? 'missing gh / auth') +
      '); verify repository rights, the cursor Environment and gh auth status');
  }
}
export function validateSetupContext(env=process.env) {
  if(env.GITHUB_ACTIONS==='true'||env.CI==='true')fail('interactive operator host required; no Actions self-rotation');
  if(env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY!==REPO)fail('wrong repository');
  return REPO;
}
export function generateSetupValues(){
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{
    modulusLength:3072,
    publicKeyEncoding:{type:'spki',format:'pem'},
    privateKeyEncoding:{type:'pkcs8',format:'pem'},
  });
  return {
    publicValue:Buffer.from(publicKey).toString('base64'),
    privateValue:Buffer.from(privateKey).toString('base64'),
  };
}
export function provision({repo=REPO,values=generateSetupValues(),run=gh}={}){
  if(repo!==REPO)fail('repository mismatch');
  // The private key is sent directly to GitHub's encrypted Environment Secret.
  // Only then do we publish the public variable that enables the seed workflow.
  run(['secret','set','CURSOR_RESUME_PRIVATE_KEY_B64','--env','cursor','--repo',repo],
    values.privateValue);
  run(['variable','set','CURSOR_RESUME_PUBLIC_KEY_B64','--repo',repo,
    '--body',values.publicValue]);
  return {repository:repo,environment:'cursor',
    private_secret:'CURSOR_RESUME_PRIVATE_KEY_B64',public_variable:'CURSOR_RESUME_PUBLIC_KEY_B64'};
}
function selfTest() {
  const mock=[];
  const values={publicValue:'PUBLIC',privateValue:'PRIVATE'};
  const result=provision({values,run:(args,input)=>{mock.push({args,input});}});
  if(mock.length!==2||mock[0].input!=='PRIVATE'||mock[1].args.at(-1)!=='PUBLIC')
    fail('setup ordering or value forwarding self-test');
  if(result.environment!=='cursor')fail('wrong Environment');
  for(const env of [{GITHUB_ACTIONS:'true'},{CI:'true'},{GITHUB_REPOSITORY:'other/repo'}]){
    let rejected=false;
    try{validateSetupContext(env);}catch{rejected=true;}
    if(!rejected)fail('unsafe execution context accepted');
  }
  const pair=generateSetupValues();
  if(!pair.publicValue||!pair.privateValue||pair.publicValue===pair.privateValue)
    fail('keypair generation failed');
  console.log('Cursor D1 setup: deterministic ordering and reject-fixtures passed');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{
    const command=process.argv[2]??'--help';
    if(command==='self-test')selfTest();
    else if(command==='--apply'&&process.argv.length===3){
      validateSetupContext();
      gh(['auth','status','--hostname','github.com']);
      gh(['api','repos/'+REPO+'/environments/cursor']);
      const result=provision();
      console.log('Cursor D1 keypair configured in '+result.repository+
        ': private Environment secret + public repository variable. No private key displayed or persisted.');
      console.log('Now dispatch Agent / Cursor Resume Seed on main, or let the next workflow push trigger it.');
    }else{
      console.log('Operator-only setup for #1664 D1\n'+
        'Prerequisites: authenticated gh CLI with permission to update GitHub Actions secrets/variables.\n'+
        'Run from a trusted local checkout: node scripts/lib/agent/providers/cursor-resume-setup.mjs --apply\n'+
        'No key contents are written to files, logs or the repository. Re-running rotates the pair.');
    }
  }catch(error){ console.error(error.message);process.exitCode=1; }
}
