#!/usr/bin/env node
// #3845: the Cursor Worker is a native Node process with no Docker precondition.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const worker=fs.readFileSync('scripts/lib/agent/orchestration/development-worker.mjs','utf8');
const developerWorkflow=fs.readFileSync('.github/workflows/agent-develop.yml','utf8');
const reviewerWorkflow=fs.readFileSync('.github/workflows/agent-review.yml','utf8');
function assertNativeWorkflow(source,entrypoint){
  assert.ok(source.includes('node '+entrypoint),'Node Worker entrypoint must be present');
  assert.doesNotMatch(source,/\bdocker\s+(?:build|run)\b/,'Docker execution must not return');
  assert.doesNotMatch(source,/NSESSION_(?:DEVELOPER|REVIEWER)_ISOLATED/);
}
assertNativeWorkflow(developerWorkflow,'scripts/lib/agent/orchestration/development-worker.mjs');
assertNativeWorkflow(developerWorkflow,'scripts/lib/agent/orchestration/qwen-development-worker.mjs');
assertNativeWorkflow(reviewerWorkflow,'scripts/lib/agent/reviewer/review-worker.mjs');
assert.match(developerWorkflow,/actions\/setup-node@v4/);
assert.match(reviewerWorkflow,/actions\/setup-node@v4/);
assert.match(developerWorkflow,/CURSOR_RIPGREP_PATH/);
assert.match(developerWorkflow,/@anthropic-ai\/claude-code@\$CLAUDE_CODE_VERSION/);
assert.match(reviewerWorkflow,/CURSOR_SDK_ROOT=\$RUNNER_TEMP\/review-sdk/);
// Direct Node Review invokes only one Provider; do not hand its competitor's key
// to the selected model process by exporting all Environment secrets.
assert.ok(reviewerWorkflow.includes("CURSOR_API_KEY: ${{ needs.prepare.outputs.reviewer == 'review-cursor-01' && secrets.CURSOR_API_KEY || '' }}"));
assert.ok(reviewerWorkflow.includes("ANTHROPIC_AUTH_TOKEN: ${{ needs.prepare.outputs.reviewer == 'review-qwen-01' && secrets.ANTHROPIC_AUTH_TOKEN || '' }}"));
assert.ok(reviewerWorkflow.includes("ANTHROPIC_API_KEY: ${{ needs.prepare.outputs.reviewer == 'review-qwen-01' && secrets.ANTHROPIC_API_KEY || '' }}"));

assert.throws(()=>assertNativeWorkflow(developerWorkflow+' docker run forbidden',
  'scripts/lib/agent/orchestration/development-worker.mjs'),/Docker execution/);
assert.throws(()=>assertNativeWorkflow(developerWorkflow.replace(
  'node scripts/lib/agent/orchestration/development-worker.mjs',
  'echo no-worker'),'scripts/lib/agent/orchestration/development-worker.mjs'),/entrypoint/);

assert.match(worker,/Node Developer requires absolute Runner workspace, SDK and temp paths/);
assert.match(worker,/sandbox:false,prompt/);
assert.doesNotMatch(worker,/\/\.dockerenv|NSESSION_DEVELOPER_ISOLATED|docker-v1/);
assert.match(worker,/assertUnprivilegedDeveloperEnvironment\(process.env\)/);
const result=spawnSync(process.execPath,[
  'scripts/lib/agent/orchestration/development-worker.mjs','/dev/null','/tmp/no-output',
],{env:{GITHUB_REPOSITORY:'BestNathan/nession',GITHUB_ACTIONS:'true'},
  encoding:'utf8',timeout:5000});
assert.notEqual(result.status,0);
assert.match(result.stderr,/Node Developer requires absolute Runner workspace/);
// Provider failure after invocation must still produce sanitized telemetry.
const telemetry=spawnSync(process.execPath,[
  'scripts/lib/agent/orchestration/development-failure-telemetry-selftest.mjs',
],{encoding:'utf8',timeout:15000});
assert.equal(telemetry.status,0,telemetry.stderr);
assert.match(telemetry.stdout,/Cursor failed Provider telemetry:/);
console.log('Agent GitHub workflows: all Developer/Reviewer paths use Node directly, no Docker; privileged credentials still rejected');
