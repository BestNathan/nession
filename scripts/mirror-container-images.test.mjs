// Deterministic ACR mirror deadline contract. No Docker/registry/network use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mirror=path.join(root,'scripts/mirror-container-images.sh');
const source='ghcr.io/bestnathan/nession';
const target='crpi.example.cn/n_public/nession';
function executable(dir,name,content){
  const file=path.join(dir,name);
  fs.writeFileSync(file,'#!/usr/bin/env node\n'+content,{mode:0o755});
}
function fixture(mode='fast'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-mirror-deadline-'));
  const events=path.join(dir,'events.log');
  executable(dir,'timeout',`
    const fs=require('node:fs');
    const {spawnSync}=require('node:child_process');
    const a=process.argv.slice(2);
    if(a[0]!=='--signal=TERM'||a[1]!=='--kill-after=15s'||
      !['90s','360s'].includes(a[2]))process.exit(90);
    fs.appendFileSync(process.env.MIRROR_TEST_EVENTS,a[2]+' '+a.slice(3).join(' ')+'\\n');
    if(process.env.MIRROR_TEST_MODE!=='fast'&&a.includes('imagetools')&&a.includes('create'))process.exit(124);
    const child=spawnSync(a[3],a.slice(4),{encoding:'utf8'});
    process.stdout.write(child.stdout||'');
    process.stderr.write(child.stderr||'');
    process.exit(child.status??1);
  `);
  executable(dir,'docker',`
    const a=process.argv.slice(2);
    if(a.join(' ').includes('inspect --raw')){
      const broken=process.env.MIRROR_TEST_MODE==='mismatch' && a[a.length-1].startsWith('crpi.');
      console.log(JSON.stringify({manifests:[
        {platform:{os:'linux',architecture:'amd64'},digest:'sha256:aaaa'},
        {platform:{os:'linux',architecture:'arm64'},digest:broken?'sha256:ffff':'sha256:bbbb'}
      ]}));
    }else if(a.includes('create'))process.exit(0);
    else process.exit(2);
  `);
  executable(dir,'regctl',`
    const fs=require('node:fs');
    const a=process.argv.slice(2);
    fs.appendFileSync(process.env.MIRROR_TEST_EVENTS,'regctl '+a.join(' ')+'\\n');
    if(a[0]==='registry'&&a[1]==='set')process.exit(0);
    if(a[0]==='image'&&a[1]==='copy'){
      if(process.env.MIRROR_TEST_MODE==='copy-fail')process.exit(124);
      process.exit(0);
    }
    if(a[0]==='index'&&a[1]==='create')process.exit(0);
    process.exit(2);
  `);
  // Retry delays are real in production; the fake makes the negative fixture deterministic.
  executable(dir,'sleep',`process.exit(0);`);
  executable(dir,'jq',`
    const fs=require('node:fs');
    const a=process.argv.slice(2);
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    if(a[0]==='-ce'){
      const found=input.manifests.filter(x=>x.platform.os==='linux'&&
        ['amd64','arm64'].includes(x.platform.architecture)).map(x=>({
          arch:x.platform.architecture,digest:x.digest
        })).sort((x,y)=>x.arch.localeCompare(y.arch));
      if(found.length!==2)process.exit(1);
      console.log(JSON.stringify(found));
    }else if(a[0]==='-r'){
      const arch=a[1].includes('amd64')?'amd64':'arm64';
      const item=input.find(x=>x.arch===arch);
      if(!item)process.exit(1);
      console.log(item.digest);
    }else process.exit(2);
  `);
  const env={...process.env,PATH:dir+path.delimiter+process.env.PATH,
    MIRROR_TEST_EVENTS:events,MIRROR_TEST_MODE:mode};
  const run=spawnSync('bash',[mirror,source,target,'0123456','0123456','agent'],{
    env,encoding:'utf8',timeout:10000
  });
  const log=fs.readFileSync(events,'utf8');
  fs.rmSync(dir,{recursive:true,force:true});
  return {run,log};
}
test('fast Buildx copy verifies both exact platform digests',()=>{
  const {run,log}=fixture('fast');
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/Verified both linux\/amd64 and linux\/arm64/);
  assert.equal((log.match(/90s docker buildx imagetools create/g)||[]).length,1);
  assert.equal((log.match(/90s docker buildx imagetools inspect/g)||[]).length,2);
  assert.doesNotMatch(log,/regctl image copy/);
});
test('a stalled Buildx copy falls back to chunked per-arch OCI transfer',()=>{
  const {run,log}=fixture('fallback');
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/chunked regctl fallback/);
  assert.match(run.stdout,/Verified both linux\/amd64 and linux\/arm64/);
  assert.equal((log.match(/90s docker buildx imagetools create/g)||[]).length,1);
  assert.match(log,/regctl registry set crpi.example.cn --blob-max 67108864 --blob-chunk 16777216/);
  assert.equal((log.match(/360s regctl image copy/g)||[]).length,2);
  assert.match(log,/image copy ghcr.io\/bestnathan\/nession@sha256:aaaa crpi.example.cn\/n_public\/nession:agent-0123456-amd64/);
  assert.match(log,/image copy ghcr.io\/bestnathan\/nession@sha256:bbbb crpi.example.cn\/n_public\/nession:agent-0123456-arm64/);
  assert.equal((log.match(/90s regctl index create/g)||[]).length,1);
  assert.match(log,/index create crpi.example.cn\/n_public\/nession:agent-0123456 --ref crpi.example.cn\/n_public\/nession:agent-0123456-amd64 --ref crpi.example.cn\/n_public\/nession:agent-0123456-arm64/);
});
test('three failed chunk uploads block index and GitOps publication',()=>{
  const {run,log}=fixture('copy-fail');
  assert.equal(run.status,1,run.stderr);
  assert.match(run.stderr,/chunked ACR copy failed for agent-0123456\/amd64 after 3 attempts/);
  assert.doesNotMatch(run.stdout,/Verified both linux/);
  assert.equal((log.match(/90s docker buildx imagetools create/g)||[]).length,1);
  assert.equal((log.match(/360s regctl image copy/g)||[]).length,3);
  assert.doesNotMatch(log,/regctl index create/);
});
test('post-copy manifest mismatch still fails closed',()=>{
  const {run}=fixture('mismatch');
  assert.equal(run.status,1,run.stderr);
  assert.match(run.stderr,/platform digests do not match GHCR/);
});
test('the independently retried ACR mirror builder retains the HTTP/1.1 transport setting',()=>{
  // imagetools create copies inside buildkitd; the runner/script GODEBUG does
  // not automatically reach that container. Keep the builder opt in the
  // workflow that owns the actual upload path.
  const workflow=fs.readFileSync(
    path.join(root,'.github/workflows/deploy-staging-acr.yml'),'utf8');
  const mirrorJob=workflow.split('\n  mirror-acr:\n')[1]??'';
  const builderStep=mirrorJob.split('docker/setup-buildx-action@v3')[1]??'';
  const beforeLogin=builderStep.split('docker/login-action@v3')[0];
  assert.match(beforeLogin,
    /driver-opts:\s*\|\s*\n\s*env\.GODEBUG=http2client=0\s*\n/,
    'the ACR mirror buildx builder must receive GODEBUG=http2client=0');
});

test('chunked fallback binary is pinned to an immutable published SHA256',()=>{
  const workflow=fs.readFileSync(
    path.join(root,'.github/workflows/deploy-staging-acr.yml'),'utf8');
  const install=workflow.split('      - name: Install pinned regctl chunked-OCI fallback')[1]
    ?.split('      - name: Mirror and verify')[0]??'';
  assert.match(install,/releases\/download\/v0\.11\.7\/regctl-linux-amd64/);
  assert.match(install,/3737fbbdd791e04e7a831640b681f3397a376498e80e2ad9b1b2d27296f239bc/);
  assert.match(install,/sha256sum -c -/);
  assert.match(install,/\$GITHUB_PATH/);
});
