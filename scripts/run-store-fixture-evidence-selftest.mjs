#!/usr/bin/env node
// #1690: prevent silently weakening the real post-merge fixture evidence owner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const workflow=fs.readFileSync('.github/workflows/ci-run-store-fixture-evidence.yml','utf8');
const catalog=fs.readFileSync('scripts/workflow-conventions.mjs','utf8');
assert.match(workflow,/^name: CI \/ Run Store Fixture Evidence$/m);
assert.match(workflow,/^on:\n  push:\n    branches: \[main\]/m);
const pushArea=workflow.split('  push:')[1]?.split('  repository_dispatch:')[0]??'';
assert.ok(pushArea,'missing main push event');
assert.doesNotMatch(pushArea,/^    paths(?:-ignore)?:/m,
  'path-filtered fixture evidence strands unrelated new main SHAs as Pending');
const waker=fs.readFileSync('.github/workflows/acceptance-postrun-waker.yml','utf8');
assert.match(waker,/workflows: \["Acceptance \/ Orchestrator", "CI \/ Run Store Fixture Evidence", "E2E \/ Tests"\]/,
  'postmerge acceptance must be awakened after exact-main-SHA fixture success');
for(const [name,source] of [
  ['Acceptance / Orchestrator','.github/workflows/acceptance-orchestrator.yml'],
  ['CI / Run Store Fixture Evidence','.github/workflows/ci-run-store-fixture-evidence.yml'],
  ['E2E / Tests','.github/workflows/e2e-tests.yml'],
]){
  assert.ok(waker.includes('.name == "'+name+'" and') &&
    waker.includes('.path == "'+source+'"'),
  'waker must authenticate the workflow name/path pair, not name alone: '+name);
}
assert.match(waker,/\.id == \$id and \.run_attempt == \$attempt and/,
  'Waker must authenticate exact GitHub run ID and attempt');
assert.match(waker,/\.repository\.full_name == \$repo and \.head_repository\.full_name == \$repo and/,
  'Waker must reject cross-repo source or head');
assert.match(waker,/\.event == "push" and \.head_branch == "main" and/,
  'Waker only accepts main-push workflow completions');
assert.match(waker,/github\.event\.workflow_run\.event == 'push'/);
assert.match(waker,/github\.event\.workflow_run\.conclusion == 'success'/);
assert.match(waker,/git merge-base --is-ancestor/);

assert.match(workflow,/^  repository_dispatch:\n    types: \[nession-run-store-fixture-evidence\]/m);
assert.doesNotMatch(workflow,/^  workflow_dispatch:/m);
assert.match(workflow,/^permissions:\n  contents: read$/m);
assert.doesNotMatch(workflow,/contents: write|actions: write|secrets\.RUN_STORE_WRITER|create-github-app-token|push origin/);
assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);
assert.match(workflow,/ref: \$\{\{ github\.sha \}\}/);
assert.match(workflow,/persist-credentials: false/);
assert.match(workflow,/\.\/gates\/run agent-checkpoint-store run-store-integrity/);
assert.match(workflow,/scripts\/run-store-fixture-evidence-selftest\.mjs/);
assert.match(workflow,/status:"fixture_pass"/);
assert.match(workflow,/real_agent_store:"not_provisioned"/);
assert.match(workflow,/external_anchor:"not_provisioned"/);
assert.match(workflow,/if: always\(\)/);
assert.match(catalog,/ci-run-store-fixture-evidence\.yml', 'CI \/ Run Store Fixture Evidence'/);
execFileSync(process.execPath,['scripts/acceptance-postrun-waker-selftest.mjs'],{stdio:'inherit'});
console.log('Main-only read-only agent-store fixture evidence contract: trusted ref, no App credentials, no production writes or external anchor assertions passed');
