#!/usr/bin/env node
// #3845: the Cursor Worker is a native Node process with no Docker precondition.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const worker=fs.readFileSync('scripts/lib/agent/orchestration/development-worker.mjs','utf8');
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
console.log('Cursor Developer Node runtime: no mandatory SDK sandbox or Docker; privileged credentials still rejected');
