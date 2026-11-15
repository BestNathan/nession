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
function fixture(failCreate=false){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-mirror-deadline-'));
  const events=path.join(dir,'events.log');
  executable(dir,'timeout',`
    const fs=require('node:fs');
    const {spawnSync}=require('node:child_process');
    const a=process.argv.slice(2);
    if(a[0]!=='--signal=TERM'||a[1]!=='--kill-after=15s'||
      !['90s','420s'].includes(a[2]))process.exit(90);
    fs.appendFileSync(process.env.MIRROR_TEST_EVENTS,a[2]+' '+a.slice(3).join(' ')+'\\n');
    if(process.env.MIRROR_TEST_FAIL==='1'&&a.includes('create'))process.exit(124);
    const child=spawnSync(a[3],a.slice(4),{encoding:'utf8'});
    process.stdout.write(child.stdout||'');
    process.stderr.write(child.stderr||'');
    process.exit(child.status??1);
  `);
  executable(dir,'docker',`
    const a=process.argv.slice(2);
    if(a.join(' ').includes('inspect --raw')){
      console.log(JSON.stringify({manifests:[
        {platform:{os:'linux',architecture:'amd64'},digest:'sha256:aaaa'},
        {platform:{os:'linux',architecture:'arm64'},digest:'sha256:bbbb'}
      ]}));
    }else if(a.includes('create'))process.exit(0);
    else process.exit(2);
  `);
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
    MIRROR_TEST_EVENTS:events,MIRROR_TEST_FAIL:failCreate?'1':'0'};
  const run=spawnSync('bash',[mirror,source,target,'0123456','0123456','agent'],{
    env,encoding:'utf8',timeout:10000
  });
  const log=fs.readFileSync(events,'utf8');
  fs.rmSync(dir,{recursive:true,force:true});
  return {run,log};
}
test('one successful upload verifies both exact platform digests with bounded reads',()=>{
  const {run,log}=fixture();
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/Verified both linux\/amd64 and linux\/arm64/);
  assert.equal((log.match(/420s docker buildx imagetools create/g)||[]).length,1);
  assert.equal((log.match(/90s docker buildx imagetools inspect/g)||[]).length,2);
});
test('expired uploads exhaust at most three bounded attempts without publication proof',()=>{
  const {run,log}=fixture(true);
  assert.equal(run.status,1,run.stderr);
  assert.match(run.stderr,/ACR mirror failed for agent-0123456 after 3 attempts/);
  assert.doesNotMatch(run.stdout,/Verified both linux/);
  assert.equal((log.match(/420s docker buildx imagetools create/g)||[]).length,3);
  assert.equal((log.match(/90s docker buildx imagetools inspect/g)||[]).length,1);
});
