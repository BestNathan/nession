#!/usr/bin/env node
// #2319: read-only admission for an isolated staging Developer proof.
// Trusted main-owned workflow code validates the exact *current staging tip*.
// This is NOT a signed Outbox dispatch, an Acceptance verdict, or permission
// to execute staging source. Future Workers MUST independently authenticate
// the Run/Attempt/Artifact and committed Store action before model execution.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const REPO='BestNathan/nession';
const WORKFLOW='Acceptance / Staging Developer Admission';
const FILE='.github/workflows/acceptance-staging-developer-admission.yml';
const SHA=/^[a-f0-9]{40}$/;
const POSITIVE=/^[1-9][0-9]*$/;
function fail(message){throw Error('Staging Developer admission: '+message);}

export function validateStagingDeveloperAdmission({context,sourceRun,stagingRef,registry}){
  if(!context||typeof context!=='object'||
      context.repository!==REPO||context.ref!=='refs/heads/main'||
      context.event!=='workflow_dispatch'||
      context.workflow!==WORKFLOW||context.actor!=='BestNathan'||
      !POSITIVE.test(String(context.run_id??''))||
      Number(context.run_attempt)!==1||
      !SHA.test(context.source_sha??'')||
      !SHA.test(context.target_sha??''))
    fail('main-owner dispatch identity or exact SHA missing');

  if(!sourceRun||sourceRun.id!==Number(context.run_id)||
      sourceRun.run_attempt!==1||
      sourceRun.repository?.full_name!==REPO||
      sourceRun.head_repository?.full_name!==REPO||
      sourceRun.path!==FILE||sourceRun.name!==WORKFLOW||
      sourceRun.event!=='workflow_dispatch'||
      sourceRun.head_branch!=='main'||
      sourceRun.head_sha!==context.source_sha||
      sourceRun.actor?.login!=='BestNathan'||
      !['queued','in_progress','completed'].includes(sourceRun.status))
    fail('GitHub Run provenance differs from owner main dispatch');

  if(stagingRef?.ref!=='refs/heads/staging'||
      stagingRef.object?.type!=='commit'||
      stagingRef.object?.sha!==context.target_sha)
    fail('target is not the exact authenticated staging branch tip');

  const identity=registry?.instances?.['dev-qwen-01'];
  if(!identity||identity.role!=='developer'||identity.provider!=='claude-code'||
      identity.environment!=='dev-claude-qwen')
    fail('Qwen Developer is not an approved registered role/provider/Environment');

  // Deliberately omit secrets, HMAC/Store state, and any privilege assertion.
  // A future consuming Worker must verify this *GitHub artifact* independently
  // before making a Store-backed task admission decision.
  return Object.freeze({
    schema_version:1,kind:'staging_developer_readonly_admission',
    issue:2319,repository:REPO,source_branch:'main',
    source_sha:context.source_sha,
    target_branch:'staging',target_sha:context.target_sha,
    source_run_id:sourceRun.id,source_run_attempt:sourceRun.run_attempt,
    workflow_path:FILE,workflow_name:WORKFLOW,
    provider_identity:'dev-qwen-01',
    selected_environment:'dev-claude-qwen',
    status:'provenance_validated_only',
    can_execute_staging_source:false,
    signed_store_dispatch_verified:false,
    acceptance_result:'Pending',
  });
}

function readJson(file){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)
    fail('unsafe GitHub metadata input');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function main(){
  if(process.argv.length!==6||process.argv[2]!=='verify')
    fail('usage: verify SOURCE_RUN_JSON STAGING_REF_JSON OUTPUT_JSON');
  if(process.env.GITHUB_ACTIONS!=='true')fail('GitHub Actions execution required');
  const context={
    repository:process.env.GITHUB_REPOSITORY,
    ref:process.env.GITHUB_REF,
    event:process.env.GITHUB_EVENT_NAME,
    workflow:process.env.GITHUB_WORKFLOW,
    actor:process.env.GITHUB_ACTOR,
    run_id:process.env.GITHUB_RUN_ID,
    run_attempt:process.env.GITHUB_RUN_ATTEMPT,
    source_sha:process.env.GITHUB_SHA,
    target_sha:process.env.STAGING_TARGET_SHA,
  };
  const result=validateStagingDeveloperAdmission({
    context,sourceRun:readJson(process.argv[3]),
    stagingRef:readJson(process.argv[4]),
    registry:readJson('automation/agents/registry.json'),
  });
  fs.writeFileSync(process.argv[5],JSON.stringify(result,null,2)+'\n',{
    flag:'wx',mode:0o600});
  console.log('Validated exact staging SHA '+result.target_sha+
    ' against trusted main Run '+result.source_run_id+
    '; no model, Store mutation or Acceptance executed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main();}catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
