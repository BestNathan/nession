#!/usr/bin/env node
// #1690: prevent silently weakening the real post-merge fixture evidence owner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const workflow=fs.readFileSync('.github/workflows/ci-run-store-fixture-evidence.yml','utf8');
const catalog=fs.readFileSync('scripts/workflow-conventions.mjs','utf8');
assert.match(workflow,/^name: CI \/ Run Store Fixture Evidence$/m);
assert.match(workflow,/^on:\n  push:\n    branches: \[main\]/m);
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
console.log('Main-only read-only agent-store fixture evidence contract: trusted ref, no App credentials, no production writes or external anchor assertions passed');
