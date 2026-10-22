#!/usr/bin/env node
// #1690 authenticated read-only consumer synthetic fixture; no network/writer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {planReceiptEvidence,verifyAuthenticatedReceipt} from './run-store-receipt-live.mjs';

const wf=fs.readFileSync('.github/workflows/store-receipt-readback.yml','utf8');
assert.match(wf,/^permissions:\s*\n  actions: read\s*\n  contents: read/m);
assert.doesNotMatch(wf,/contents: write|permission-contents: write|RUN_STORE_WRITER_APP_PRIVATE_KEY/);
assert.match(wf,/github.ref == 'refs\/heads\/main'/);
assert.match(wf,/repository_dispatch:/);
assert.match(wf,/nession-run-store-receipt-readback/);
assert.doesNotMatch(wf,/^  workflow_dispatch:/m);
assert.match(wf,/persist-credentials: false/);
assert.match(wf,/run-store-receipt-live.mjs plan/);
assert.match(wf,/run-store-receipt-live.mjs verify/);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-live-fixture-'));
const g=(...args)=>execFileSync('git',['-C',home,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const copy=x=>JSON.parse(JSON.stringify(x));
try{
 g('init','-q');g('config','user.name','test');g('config','user.email','test@example.invalid');
 fs.writeFileSync(path.join(home,'README.md'),'root\n');g('add','README.md');g('commit','-qm','root');
 const root=g('rev-parse','HEAD');
 fs.mkdirSync(path.join(home,'raw/workflows/agent-provider-smoke/2026-10-15'),{recursive:true});
 const file='raw/workflows/agent-provider-smoke/2026-10-15/123-1-test.json';
 const body='{"verified":true}\n';
 fs.writeFileSync(path.join(home,file),body);g('add','-A');g('commit','-qm','append metric');
 const persisted=g('rev-parse','HEAD');
 const ingest={id:777,run_attempt:1,repository:{full_name:'BestNathan/nession'},
   head_repository:{full_name:'BestNathan/nession'},head_branch:'main',head_sha:root,
   status:'completed',conclusion:'success',event:'workflow_run',
   name:'Metrics / Agent Telemetry Ingest',path:'.github/workflows/metrics-agent-telemetry.yml'};
 const artifact={id:909,name:'run-store-receipt-777-1-agent',expired:false,digest:'sha256:'+hash('zip'),
   workflow_run:{id:777,head_sha:root}};
 const listed={artifacts:[artifact]};
 const plan=planReceiptEvidence(ingest,listed,'777','1');
 assert.equal(plan.artifacts.length,1);
 assert.equal(plan.store,'metrics');
 const source={id:123,run_attempt:1,repository:{full_name:'BestNathan/nession'},
   head_repository:{full_name:'BestNathan/nession'},head_sha:root,
   event:'push',path:'.github/workflows/agent-provider-smoke.yml',workflow_id:987};
 const receipt={schema_version:1,kind:'run_store_post_commit_receipt',
   trust_level:'trusted_workflow_artifact_not_independent_anchor',
   status:'published',ref:'refs/heads/metrics',store:'metrics',commit_sha:persisted,
   ingester:{repository:'BestNathan/nession',run_id:'777',attempt:'1',
     workflow_ref:'BestNathan/nession/.github/workflows/metrics-agent-telemetry.yml@refs/heads/main',
     tool_sha:root},
   source:{workflow_id:'987',workflow_path:'.github/workflows/agent-provider-smoke.yml',
     repository:'BestNathan/nession',run_id:'123',attempt:'1',target_sha:root,event:'push'},
   records:[{path:file,sha256:hash(body)}]};
 const verify=(a=ingest,b=plan,c=receipt,d=source)=>verifyAuthenticatedReceipt(a,listed,b,artifact.name,c,d,home,home);
 const ok=verify();
 assert.equal(ok.checked_records,1);
 assert.equal(ok.artifact_id,909);
 assert.equal(ok.trust_level,'github_actions_authenticated_not_independent_anchor');
 const noReceipt=planReceiptEvidence(ingest,{artifacts:[]},777,1);
 assert.equal(noReceipt.status,'no-publication-receipt-pending');
 const altered=copy(ingest);altered.head_branch='pull/1/merge';
 assert.throws(()=>planReceiptEvidence(altered,listed,777,1),/trusted-main/);
 altered.head_branch='main';altered.event='pull_request';
 assert.throws(()=>planReceiptEvidence(altered,listed,777,1),/unsupported/);
 const broken=copy(listed);broken.artifacts[0].workflow_run.id=0;
 assert.throws(()=>planReceiptEvidence(ingest,broken,777,1),/forged\/duplicate/);
 assert.throws(()=>planReceiptEvidence(ingest,listed,777,2),/event\/input/);
 broken.artifacts[0]=copy(artifact);broken.artifacts.push(copy(artifact));
 assert.throws(()=>planReceiptEvidence(ingest,broken,777,1),/forged\/duplicate/);
 const falseIngest=copy(receipt);falseIngest.ingester.run_id='888';
 assert.throws(()=>verify(ingest,plan,falseIngest),/ingester identity/);
 const falseSource=copy(receipt);falseSource.source.target_sha='b'.repeat(40);
 assert.throws(()=>verify(ingest,plan,falseSource),/source run GitHub REST/);
 const falseStore=copy(receipt);falseStore.records[0].sha256='c'.repeat(64);
 assert.throws(()=>verify(ingest,plan,falseStore),/record bytes differ/);
 const fakeTool=copy(receipt);fakeTool.ingester.tool_sha='d'.repeat(40);
 assert.throws(()=>verify(ingest,plan,fakeTool),/unverifiable trusted-main SHA ancestry/);
 const falsePlan=copy(plan);falsePlan.workflow='.github/workflows/attacker.yml';
 assert.throws(()=>verify(ingest,falsePlan),/plan changed/);
 console.log('Trusted read-only receipt consumer: positive GitHub API lineage + SHA tree; untrusted run/source/artifact/tool/record negatives passed');
}finally{fs.rmSync(home,{force:true,recursive:true});}
