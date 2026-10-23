#!/usr/bin/env node
// #2095: Execute the production Quality selector against real Git diffs.
// Never duplicate the path-selection policy here; workflows own their routing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prPaths} from './lib/workflow-pr-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = {};
for (const [name,filename] of Object.entries({
  quality:'ci-quality.yml',
  e2e:'e2e-tests.yml',
  cases:'acceptance-case-smoke.yml',
  scenario:'e2e-scenario-smoke.yml',
})) sources[name] = fs.readFileSync(path.join(root,'.github/workflows',filename),'utf8');

function classifier() {
  const lines=sources.quality.split('\n');
  const i=lines.indexOf('      - name: Select impacted checks from the exact PR diff');
  assert.ok(i>=0,'production Quality selector missing');
  const j=lines.indexOf('        run: |',i);
  assert.ok(j>i,'production Quality run block missing');
  const body=[];
  for(let n=j+1;n<lines.length;n++){
    if(lines[n].startsWith('          '))body.push(lines[n].slice(10));
    else if(!lines[n].trim())body.push('');
    else break;
  }
  const script=body.join('\n');
  assert.ok(script.includes('git merge-base') && script.includes('git diff --no-renames --name-only -z') && script.includes('git rev-parse "$target^1"'),
    'Quality selector must use exact PR diff');
  return script;
}
const globs=Object.fromEntries(Object.entries(sources).map(([key,s])=>[key,prPaths(s)]));
const script=classifier();
const cases=[
  {name:'controller-only', files:['.github/workflows/agent-controller-dispatch.yml'], quality:[false,false,true], e2e:false,cases:false,scenario:false},
  {name:'rust-only', files:['crates/nession-server/src/lib.rs'], quality:[true,false,false], e2e:true,cases:true,scenario:true},
  {name:'web-only', files:['web/src/App.tsx'], quality:[false,true,false], e2e:true,cases:true,scenario:false},
  {name:'web-terminal', files:['web/src/product/terminal/index.ts'], quality:[false,true,false], e2e:true,cases:true,scenario:true},
  {name:'acceptance-case', files:['e2e/acceptance/cases/1258/SC-03/verify.js'], quality:[false,true,false], e2e:true,cases:true,scenario:false},
  {name:'scenario', files:['e2e/scenarios/terminal-attach-resume.mjs'], quality:[false,true,false], e2e:true,cases:true,scenario:true},
  {name:'shared-gate', files:['gates/checks/quality.sh'], quality:[true,true,false], e2e:true,cases:true,scenario:false},
  {name:'shared-script', files:['scripts/acceptance-case-smoke-select.mjs'], quality:[true,true,false], e2e:true,cases:true,scenario:false},
  {name:'cargo-lock', files:['Cargo.lock'], quality:[true,false,false], e2e:true,cases:true,scenario:true},
  {name:'rust-clippy-config', files:['clippy.toml'], quality:[true,false,false], e2e:false,cases:false,scenario:false},
  {name:'quality-yaml', files:['.github/workflows/ci-quality.yml'], quality:[true,true,true], e2e:false,cases:false,scenario:false},
  {name:'e2e-yaml', files:['.github/workflows/e2e-tests.yml'], quality:[false,false,true], e2e:true,cases:false,scenario:false},
  {name:'case-yaml', files:['.github/workflows/acceptance-case-smoke.yml'], quality:[false,false,true], e2e:false,cases:true,scenario:false},
  {name:'docs-only', files:['docs/engineering/notes.md'], quality:null, e2e:false,cases:false,scenario:false},
];
function git(dir,args) {
  const r=spawnSync('git',args,{cwd:dir,encoding:'utf8'});
  assert.equal(r.status,0,'git '+args.join(' ')+' failed: '+r.stderr);
  return r.stdout.trim();
}
function select(files,eventName='pull_request') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-ci-scope-'));
  try {
    git(dir,['init','-q']);
    git(dir,['config','user.name','CI Fixture']);
    git(dir,['config','user.email','ci@example.invalid']);
    fs.writeFileSync(path.join(dir,'base.txt'),'base\n');
    git(dir,['add','.']);git(dir,['commit','-qm','base']);
    const base=git(dir,['rev-parse','HEAD']);
    for(const file of files) {
      const dest=path.join(dir,file);
      fs.mkdirSync(path.dirname(dest),{recursive:true});
      fs.writeFileSync(dest,'changed\n');
    }
    git(dir,['add','.']);git(dir,['commit','-qm','changes']);
    const head=git(dir,['rev-parse','HEAD']), output=path.join(dir,'out');
    const result=spawnSync('bash',['-c',script],{cwd:dir,encoding:'utf8',env:{
      ...process.env,EVENT_NAME:eventName,PR_BASE_SHA:base,PR_HEAD_SHA:head,GITHUB_SHA:head,
      GITHUB_OUTPUT:output,RUNNER_TEMP:dir,
    }});
    assert.equal(result.status,0,'Quality scope failed: '+result.stderr+' '+result.stdout);
    const values=Object.fromEntries(fs.readFileSync(output,'utf8').trim().split('\n').map(s=>s.split('=')));
    return ['rust','web','workflow'].map(key=>values[key]==='true');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
for(const fixture of cases) {
  for(const key of ['quality','e2e','cases','scenario']) {
    const matched=fixture.files.some(file=>globs[key].some(pattern=>path.matchesGlob(file,pattern)));
    const expected=key==='quality'?fixture.quality!==null:fixture[key];
    assert.equal(matched,expected,key+' trigger mismatch for '+fixture.name);
  }
  if(fixture.quality!==null)
    assert.deepEqual(select(fixture.files),fixture.quality,
      'Quality PR jobs incorrectly selected for '+fixture.name);
  // A main-push owns its independent exact-commit source scope. Inapplicable
  // module jobs must remain skipped, not pass because the workflow is green.
  assert.deepEqual(select(fixture.files,'push'),
    fixture.quality??[false,false,false],
    'Quality merged-SHA jobs incorrectly selected for '+fixture.name);
}
console.log('CI trigger scopes: '+cases.length+' exact-diff regression fixtures passed');
