#!/usr/bin/env node
// #2319: authenticate the read-only main-owned admission's exact GitHub ZIP.
// No Provider/Store secrets here; admission NEVER substitutes for a signed
// committed Outbox action or permits executing code from the staging tree.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readWorkerZipMember} from './worker-zip.mjs';

const REPO='BestNathan/nession';
const FILE='.github/workflows/acceptance-staging-developer-admission.yml';
const NAME='Acceptance / Staging Developer Admission';
const SHA=/^[0-9a-f]{40}$/;
const DIGEST=/^sha256:[0-9a-f]{64}$/;
function fail(message){throw Error('Staging Developer source: '+message);}
export function verifyStagingDeveloperSource({run,artifacts,zip}){
  if(!run||!Number.isSafeInteger(run.id)||run.id<1||
      run.run_attempt!==1||run.path!==FILE||run.name!==NAME||
      run.event!=='workflow_dispatch'||run.head_branch!=='main'||
      run.actor?.login!=='BestNathan'||
      run.repository?.full_name!==REPO||
      run.head_repository?.full_name!==REPO||
      !SHA.test(run.head_sha??'')||
      run.status!=='completed'||run.conclusion!=='success')
    fail('untrusted or incomplete upstream main-only admission Run');
  if(!artifacts||!Array.isArray(artifacts.artifacts)||
      !Number.isInteger(artifacts.total_count)||
      artifacts.total_count<0||artifacts.total_count>100||
      artifacts.artifacts.length!==artifacts.total_count)
    fail('unbounded or incomplete artifact listing');
  const name='staging-development-admission-'+run.id+'-'+run.run_attempt;
  const matches=artifacts.artifacts.filter(a=>a.name===name);
  if(matches.length!==1||matches[0].expired!==false||
      !Number.isSafeInteger(matches[0].id)||matches[0].id<1||
      matches[0].workflow_run?.id!==run.id||
      matches[0].workflow_run?.head_sha!==run.head_sha||
      !DIGEST.test(matches[0].digest??''))
    fail('missing/ambiguous authenticated admission artifact');
  if(!Buffer.isBuffer(zip)||zip.length>256*1024||
      'sha256:'+createHash('sha256').update(zip).digest('hex')!==matches[0].digest)
    fail('admission ZIP differs from GitHub-authenticated digest');
  let record;
  try{record=JSON.parse(readWorkerZipMember(zip,'staging-developer-admission.json').toString('utf8'));}
  catch{fail('invalid bounded staging admission member');}
  if(record?.schema_version!==1||
      record.kind!=='staging_developer_readonly_admission'||
      record.issue!==2319||
      record.repository!==REPO||record.workflow_path!==FILE||
      record.workflow_name!==NAME||
      record.source_branch!=='main'||record.source_sha!==run.head_sha||
      record.target_branch!=='staging'||!SHA.test(record.target_sha??'')||
      record.source_run_id!==run.id||record.source_run_attempt!==run.run_attempt||
      record.provider_identity!=='dev-qwen-01'||
      record.selected_environment!=='dev-claude-qwen'||
      record.status!=='provenance_validated_only'||
      record.can_execute_staging_source!==false||
      record.signed_store_dispatch_verified!==false||
      record.acceptance_result!=='Pending')
    fail('admission record is incompatible with trusted staging proof');
  // No field here claims a Store CAS receipt, credential grant, or SC Pass.
  return Object.freeze({target_sha:record.target_sha,
    source_sha:record.source_sha,source_run_id:run.id,
    source_run_attempt:run.run_attempt,artifact_id:matches[0].id,
    artifact_digest:matches[0].digest,
    verified_proof:'synthetic_worker_canary_only'});
}
function json(file){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>1024*1024)fail('unsafe source file');return JSON.parse(fs.readFileSync(file,'utf8'));}
function main(){
  if(process.argv.length!==7||process.argv[2]!=='verify')
    fail('usage: verify RUN_JSON ARTIFACTS_JSON ZIP OUTPUT_JSON');
  const zip=fs.readFileSync(process.argv[5]);
  const out=verifyStagingDeveloperSource({
    run:json(process.argv[3]),artifacts:json(process.argv[4]),zip});
  fs.writeFileSync(process.argv[6],JSON.stringify(out,null,2)+'\n',
    {flag:'wx',mode:0o600});
  console.log('Authenticated non-authoritative staging model proof target '+out.target_sha);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main();}catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
