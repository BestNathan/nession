#!/usr/bin/env node
// #2010 OS sandbox must be an explicit container, never a pretend SDK toggle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const file='.github/workflows/agent-develop.yml';
const text=fs.readFileSync(file,'utf8');
const block=text.split('      - name: Execute real Developer in isolated Docker with no host credentials\n')[1]?.split('\n      - name: Upload canonical')[0];
assert.ok(block,'isolated execution step missing');
function safe(workflow) {
  const needed=[
    'docker run --rm --read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    '--memory=4g',
    '--network=bridge',
    '-e NESSION_DEVELOPER_ISOLATED=docker-v1',
    '-v "$GITHUB_WORKSPACE:/trusted-code:ro"',
    '-v "$RUNNER_TEMP/development-checkout:/workspace:rw"',
    '-v "$RUNNER_TEMP/development-sdk:/sdk:ro"',
    '-v "$RUNNER_TEMP/development-admission.json:/admission.json:ro"',
    '-v "$RUNNER_TEMP/development-output:/output:rw"',
    '-e GITHUB_WORKSPACE=/workspace',
    '-e CURSOR_SDK_ROOT=/sdk',
    'nession-cursor-worker-rg:local',
    'node scripts/lib/agent/orchestration/development-worker.mjs',
  ];
  const denied=['-e STORE_APP_TOKEN','-e STORE_WRITER_PRIVATE_KEY',
    '-e ACTIONS_DISPATCH_TOKEN','-e GITHUB_TOKEN','-e GH_TOKEN',
    '-v "$HOME','-v "/var/run/docker.sock','--privileged','--cap-add'];
  return needed.every(x=>workflow.includes(x))&&!denied.some(x=>workflow.includes(x));
}
assert.match(text,/Build credential-free Cursor runtime with mandatory ripgrep/);
assert.match(text,/docker build --pull=false --tag nession-cursor-worker-rg:local/);
assert.match(text,/docker run --rm --network=none --read-only --cap-drop=ALL/);
const dockerfile=fs.readFileSync(
  'scripts/lib/agent/orchestration/cursor-worker.Dockerfile','utf8');
assert.match(dockerfile,/^FROM node:24-bookworm$/m);
assert.match(dockerfile,/apt-get install -y --no-install-recommends ripgrep/);
assert.doesNotMatch(dockerfile,/^(?:COPY|ADD|ARG|ENV|RUN .*curl|RUN .*wget)\b/m);
const worker=fs.readFileSync(
  'scripts/lib/agent/orchestration/development-worker.mjs','utf8');
const preflight=worker.indexOf("execFileSync('rg',['--version']");
const providerCall=worker.indexOf('await runCursorSession({');
const reported=worker.indexOf('Developer Provider outcome metadata');
const evidence=worker.indexOf("fail('real native read/edit Provider outcome missing')");
assert.ok(preflight>0&&providerCall>preflight&&reported>providerCall&&
  evidence>reported,'ripgrep preflight and safe status diagnostics must bracket the model call');
assert.match(worker,/isolated Cursor SDK ripgrep runtime unavailable before Provider call/);
assert.doesNotMatch(worker.slice(reported,evidence),/result\.result|\.prompt|\.content|\.text/);
assert.equal(safe(block),true);
for(const flag of ['--read-only','--cap-drop=ALL','-e CURSOR_SDK_ROOT=/sdk',
  '-v "$GITHUB_WORKSPACE:/trusted-code:ro"','-e NESSION_DEVELOPER_ISOLATED=docker-v1'])
  assert.equal(safe(block.replace(flag,'')),false);
const result=spawnSync(process.execPath,[
  'scripts/lib/agent/orchestration/development-worker.mjs','/dev/null','/tmp/no-output',
],{env:{GITHUB_REPOSITORY:'BestNathan/nession',GITHUB_ACTIONS:'true'},
  encoding:'utf8',timeout:5000});
assert.notEqual(result.status,0);
assert.match(result.stderr,/OS-isolated Docker worker is mandatory/);
console.log('Developer Docker boundary: exact secretless mounts, no host privileged capability and no-host fail-closed verified');
