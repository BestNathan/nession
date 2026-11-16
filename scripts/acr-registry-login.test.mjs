// Contract tests for isolated, bounded ACR authentication; no network/secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/ci/acr-registry-login.sh');
function fixture(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-acr-login-'));
  const calls = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'timeout'), `#!/usr/bin/env node
    const {spawnSync}=require('node:child_process');
    const a=process.argv.slice(2);
    if (a.slice(0,3).join(' ')!=='--signal=TERM --kill-after=5s 30s') process.exit(91);
    const r=spawnSync(a[3],a.slice(4),{encoding:'utf8',input:require('node:fs').readFileSync(0)});
    process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');
    process.exit(r.status??1);
  `, {mode:0o755});
  fs.writeFileSync(path.join(dir, 'docker'), `#!/usr/bin/env node
    const fs=require('node:fs');
    const a=process.argv.slice(2);
    const calls=process.env.ACR_TEST_CALLS;
    const n=fs.existsSync(calls)?+fs.readFileSync(calls,'utf8'):0;
    fs.writeFileSync(calls,String(n+1));
    if(a[0]!=='login'||a[2]!=='--username'||a[4]!=='--password-stdin') process.exit(92);
    if(process.env.ACR_TEST_MODE==='auth') {
      console.error('unauthorized: incorrect password should never reveal SECRET-PASSWORD');process.exit(1);
    }
    if(process.env.ACR_TEST_MODE==='transient' && n===0) {
      console.error('read: connection reset by peer with SECRET-PASSWORD');process.exit(1);
    }
    if(process.env.ACR_TEST_MODE==='timeout') process.exit(124);
    console.log('Login Succeeded!');
  `, {mode:0o755});
  fs.writeFileSync(path.join(dir, 'sleep'), '#!/usr/bin/env node\nprocess.exit(0);\n', {mode:0o755});
  const run = spawnSync('bash', [script,'registry.example.cn'], {
    encoding:'utf8', timeout:10000,
    env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,
      ACR_USERNAME:'sample-user',ACR_PASSWORD:'SECRET-PASSWORD',
      ACR_TEST_MODE:mode,ACR_TEST_CALLS:calls},
  });
  const count=+fs.readFileSync(calls,'utf8');
  fs.rmSync(dir,{recursive:true,force:true});
  return {run,count,output:run.stdout+run.stderr};
}
test('successful ACR login uses one bounded attempt',()=>{
  const {run,count,output}=fixture('success');
  assert.equal(run.status,0,output);
  assert.equal(count,1);
  assert.match(output,/ACR_LOGIN_ATTEMPT attempt=1 .*outcome=success/);
  assert.doesNotMatch(output,/SECRET-PASSWORD/);
});
test('transient reset retries and emits only sanitized classification',()=>{
  const {run,count,output}=fixture('transient');
  assert.equal(run.status,0,output);
  assert.equal(count,2);
  assert.match(output,/outcome=connection_reset/);
  assert.doesNotMatch(output,/SECRET-PASSWORD/);
});
test('rejected credentials are terminal, with no retries or secret leaks',()=>{
  const {run,count,output}=fixture('auth');
  assert.equal(run.status,1);
  assert.equal(count,1);
  assert.match(output,/outcome=credential_or_permission_rejected/);
  assert.doesNotMatch(output,/SECRET-PASSWORD/);
});
test('deadline is bounded, classified and fails closed',()=>{
  const {run,count,output}=fixture('timeout');
  assert.equal(run.status,1);
  assert.equal(count,3);
  assert.match(output,/exhausted 3 bounded transport attempts/);
  assert.doesNotMatch(output,/SECRET-PASSWORD/);
});
