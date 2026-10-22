#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildControllerRequest,verifyControllerRequestSource,
  inspectControllerRequestZip} from './controller-request.mjs';

const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
const sourceSha='a'.repeat(40),issue=3001;
const inputs={issue_number:String(issue),input_sha:'b'.repeat(40),
  developer:'dev-cursor-01',reviewer:'review-cursor-01',acceptor:'accept-cursor-01'};
const context={repository:'BestNathan/nession',workflow:'Acceptance / Agent Controller',
  workflow_path:'.github/workflows/acceptance-agent-controller.yml',
  event:'workflow_dispatch',ref:'refs/heads/main',head_sha:sourceSha,
  run_id:1001,attempt:1,actor:'BestNathan'};
const request=buildControllerRequest(inputs,context,registry);
assert.equal(request.request.issue,issue);
assert.equal(request.run.actor,'BestNathan');
assert.throws(()=>buildControllerRequest({...inputs,developer:'review-cursor-01'},
  context,registry),/role or ID/);
assert.throws(()=>buildControllerRequest({...inputs,inject:'secret'},context,registry),
  /extra/);
assert.throws(()=>buildControllerRequest({...inputs,input_sha:'main'},context,registry),
  /invalid/);
assert.throws(()=>buildControllerRequest(inputs,{...context,actor:'external'},registry),
  /untrusted/);
assert.throws(()=>buildControllerRequest(inputs,{...context,ref:'refs/heads/feature'},registry),
  /untrusted/);

const upstream={id:1001,run_attempt:1,head_sha:sourceSha,
  name:'Acceptance / Agent Controller',
  path:'.github/workflows/acceptance-agent-controller.yml',
  repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},
  actor:{login:'BestNathan'},event:'workflow_dispatch',
  head_branch:'main',status:'completed',conclusion:'success'};
const expected={run_id:1001,attempt:1,head_sha:sourceSha};
const artifact={id:555,name:'agent-controller-request-1001-1',
  expired:false,digest:'sha256:'+'c'.repeat(64),size_in_bytes:512,
  workflow_run:{id:1001,head_sha:sourceSha}};
const listing={artifacts:[artifact]};
assert.deepEqual(verifyControllerRequestSource(upstream,listing,expected),
  {artifact_id:555,digest:artifact.digest});
for(const change of [
  {actor:{login:'untrusted'}},{head_repository:{full_name:'other/fork'}},
  {head_branch:'feature'},{run_attempt:2},{conclusion:'failure'},
  {path:'.github/workflows/evil.yml'},
]) assert.throws(()=>verifyControllerRequestSource({...upstream,...change},listing,expected),
  /not trusted owner/);
assert.throws(()=>verifyControllerRequestSource(upstream,{artifacts:[artifact,artifact]},
  expected),/ambiguous/);
assert.throws(()=>verifyControllerRequestSource(upstream,
  {artifacts:[{...artifact,expired:true}]},expected),/ambiguous/);
assert.throws(()=>verifyControllerRequestSource(upstream,
  {artifacts:[{...artifact,digest:'sha256:'+'z'.repeat(64)}]},expected),/ambiguous/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'controller-request-zip-'));
try{
  const make=(doc,name='controller-request.json',repeat=false)=>{
    const source=path.join(root,'record.json'),zip=path.join(root,'artifact.zip');
    fs.writeFileSync(source,JSON.stringify(doc));
    execFileSync('python3',['-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED); z.write(sys.argv[2],sys.argv[3]); z.write(sys.argv[2],sys.argv[3]) if sys.argv[4]=="1" else None; z.close()',
      zip,source,name,repeat?'1':'0'],{stdio:['ignore','pipe','pipe']});
    const bytes=fs.readFileSync(zip);
    return {bytes,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
  };
  const right=make(request);
  assert.deepEqual(inspectControllerRequestZip(right.bytes,right.digest,
    upstream,expected,registry),request);
  assert.throws(()=>inspectControllerRequestZip(right.bytes,
    'sha256:'+'d'.repeat(64),upstream,expected,registry),/digest mismatch/);
  assert.throws(()=>inspectControllerRequestZip(right.bytes,right.digest,
    upstream,{...expected,attempt:2},registry),/source binding mismatch/);
  const tampered=make({...request,run:{...context,actor:'untrusted'}});
  assert.throws(()=>inspectControllerRequestZip(tampered.bytes,tampered.digest,
    upstream,expected,registry),/untrusted/);
  const foreign=make(request,'../escape.json');
  assert.throws(()=>inspectControllerRequestZip(foreign.bytes,foreign.digest,
    upstream,expected,registry),/unexpected ZIP member/);
  const duplicated=make(request,'controller-request.json',true);
  assert.throws(()=>inspectControllerRequestZip(duplicated.bytes,duplicated.digest,
    upstream,expected,registry),/ZIP|archive/);
  const privileged=make({...request,issue_admin:true});
  assert.throws(()=>inspectControllerRequestZip(privileged.bytes,privileged.digest,
    upstream,expected,registry),/schema/);
  console.log('Controller request: attested owner/main Run, unique digest-bound ZIP, readonly request and fork/spoof negatives passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
