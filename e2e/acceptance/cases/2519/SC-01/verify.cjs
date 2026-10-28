'use strict';
// #2519 SC-01. A branch-local GitHub workflow cannot be inspected by an
// Agent restricted to the main checkout. Fetch the real orphan source bytes
// and historical executed signal from fixed, read-only public endpoints.
// Strict equality intentionally fails closed if the branch's workflow mutates.
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const WITNESS_SHA = 'b929fe89321b4bcc74d76e889f5c56c359a274cf';
const SIGNAL_RUN = 40534958867;
const EXPECTED_SOURCE = "name: Prototype / Change Signal\n\n# Unprivileged event bridge only. Main owns sanitized Pages publication.\n# This orphan branch MUST NOT acquire Pages, Actions write or secrets.\non:\n  push:\n    branches: [prototype]\n\npermissions:\n  contents: read\n\njobs:\n  signal:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 3\n    steps:\n      - name: Record prototype branch revision\n        shell: bash\n        run: |\n          echo \"Prototype source revision: $GITHUB_SHA\"\n          echo \"The trusted main Pages workflow receives only this run-completed event.\"\n";
const SHA = /^[a-f0-9]{40}$/;
const root = path.resolve(__dirname, '../../../../..');

async function publicRead(url, json = false) {
  const target = new URL(url);
  assert.ok(['api.github.com', 'raw.githubusercontent.com'].includes(target.hostname),
    'only approved read-only GitHub hosts may be fetched');
  const headers = {'User-Agent': 'nession-2519-source-boundary', Accept: json ? 'application/vnd.github+json' : 'text/plain'};
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (json && token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, {headers, signal: AbortSignal.timeout(20000)});
  assert.equal(res.status, 200, 'HTTP ' + res.status + ' from ' + target.pathname);
  return json ? res.json() : res.text();
}

async function main() {
  const targetSha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  assert.match(targetSha, SHA);
  const actual = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(actual,targetSha,'Case must run from exact merged-main HEAD');

  const [ref, run] = await Promise.all([
    publicRead(API + '/git/ref/heads/prototype', true),
    publicRead(API + '/actions/runs/' + SIGNAL_RUN, true),
  ]);
  const sha=ref?.object?.sha;
  assert.match(sha, SHA, 'current prototype ref must identify one Git commit');
  assert.equal(ref.ref,'refs/heads/prototype');
  assert.equal(run.name,'Prototype / Change Signal');
  assert.equal(run.event,'push');
  assert.equal(run.head_branch,'prototype');
  assert.equal(run.head_repository?.full_name,REPO);
  assert.equal(run.head_sha,WITNESS_SHA);
  assert.equal(run.status,'completed');
  assert.equal(run.conclusion,'success');

  const actualSource=await publicRead('https://raw.githubusercontent.com/' + REPO + '/' +
    sha + '/.github/workflows/prototype-changed.yml');
  assert.equal(actualSource,EXPECTED_SOURCE,
    'Orphan branch workflow bytes changed: read-only push/echo-only security contract must be re-audited');
  // A future orphan commit may update mock assets, but cannot rewrite or
  // loosen this source-only workflow without an explicit security review.
  if(sha!==WITNESS_SHA){
    const c=await publicRead(API+'/compare/'+WITNESS_SHA+'...'+sha,true);
    assert.ok(['ahead','identical'].includes(c.status),'signal witness is not in current prototype history');
  }
  const digest=createHash('sha256').update(actualSource).digest('hex');
  process.stdout.write(JSON.stringify({
    status:'pass',
    summary:'Actual orphan workflow is contents-read/push-only/echo-only and successfully emitted a real signal',
    evidence:[
      {type:'runtime',value:'Current prototype ref '+sha+' has audited source bytes sha256='+digest+
        ': push:prototype only, contents:read only, single echo-only signal job; no checkout, secrets, write/Pages permission or prototype execution'},
      {type:'runtime',value:'GitHub Actions Run '+SIGNAL_RUN+' is completed/success, same-repository source push at '+WITNESS_SHA},
      {type:'runtime',value:'Exact Acceptance target HEAD '+targetSha+' checked independently from current orphan source'},
    ],
  })+'\n');
}
main().catch(e=>{
  process.stdout.write(JSON.stringify({
    status:'fail',summary:String(e?.message||e).slice(0,2000),
    evidence:[{type:'runtime',value:'Source workflow bytes or independently observed successful signal not proven'}],
  })+'\n');
  process.exitCode=1;
});
