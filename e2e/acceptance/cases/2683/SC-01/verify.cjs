'use strict';
// #2683 SC-01: real, unprivileged Knowledge push signal + byte-pinned source.
// No GitHub mutations or synthetic workflow events are made by this verifier.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

const REPO='BestNathan/nession';
const API='https://api.github.com/repos/'+REPO;
const SHA=/^[a-f0-9]{40}$/;
const WITNESS_SHA='a0d92aa9088c50fb1956463f466a1f25e2a1dc47';
const WITNESS_RUN=41617084950;
const PINNED_SOURCE_SHA256='2a546df4f9e7d4bb49a4aa01cca7ca4b5366cfe88937ac3cae3a728d5274b98a';
const root=path.resolve(__dirname,'../../../../..');

function targetSha(){
  const target=String(process.env.NESSION_ACCEPTANCE_TARGET_SHA||'');
  assert.match(target,SHA,'Exact main acceptance target SHA required');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),target,
    'Case checkout must be exact main acceptance target');
  return target;
}
async function read(url,json=false){
  const host=new URL(url).hostname;
  assert.ok(['api.github.com','raw.githubusercontent.com'].includes(host));
  const headers={'User-Agent':'nession-2683-knowledge-signal-proof'};
  const token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
  if(host==='api.github.com'&&token)headers.Authorization='Bearer '+token;
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200,'HTTP '+response.status+' from '+new URL(url).pathname);
  return json?response.json():response.text();
}
async function main(){
  const target=targetSha();
  const [ref,signal]=await Promise.all([
    read(API+'/git/ref/heads/knowledge',true),
    read(API+'/actions/runs/'+WITNESS_RUN,true),
  ]);
  assert.equal(ref.ref,'refs/heads/knowledge');
  const head=ref.object.sha;
  assert.match(head,SHA);
  assert.equal(signal.id,WITNESS_RUN);
  assert.equal(signal.name,'Knowledge / Change Signal');
  assert.equal(signal.path,'.github/workflows/knowledge-changed.yml');
  assert.equal(signal.event,'push');
  assert.equal(signal.head_branch,'knowledge');
  assert.equal(signal.head_repository?.full_name,REPO);
  assert.equal(signal.head_sha,WITNESS_SHA);
  assert.equal(signal.status,'completed');
  assert.equal(signal.conclusion,'success');
  assert.ok(signal.run_attempt>=1);
  const source=await read('https://raw.githubusercontent.com/'+REPO+'/'+head+
    '/.github/workflows/knowledge-changed.yml');
  const digest=createHash('sha256').update(source).digest('hex');
  assert.equal(digest,PINNED_SOURCE_SHA256,'Orphan signal may not change even when Knowledge articles change');
  if(head!==WITNESS_SHA){
    const compare=await read(API+'/compare/'+WITNESS_SHA+'...'+head,true);
    assert.ok(['ahead','identical'].includes(compare.status),
      'Current Knowledge ref must preserve successful signal witness ancestry');
  }
  process.stdout.write(JSON.stringify({
    status:'pass',
    summary:'Real Knowledge push produced the byte-pinned unprivileged change signal on the exact source commit',
    evidence:[
      {type:'runtime',value:'GitHub push Run '+WITNESS_RUN+' attempt '+signal.run_attempt+
        ': success; name='+signal.name+' branch='+signal.head_branch+' head='+WITNESS_SHA+
        ' source_workflow='+signal.path},
      {type:'runtime',value:'Current Knowledge source '+head+
        ': workflow source SHA-256='+digest+' equals trusted pinned read-only notifier'},
      {type:'runtime',value:'Exact main Acceptance target SHA='+target+' checked from Git worktree'},
    ],
  })+'\n');
}
main().catch(error=>{
  process.stdout.write(JSON.stringify({
    status:'fail',summary:String(error?.message||error).slice(0,1800),
    evidence:[{type:'runtime',value:'Failed to authenticate original Knowledge branch signal or exact workflow bytes'}],
  })+'\n');
  process.exitCode=1;
});
