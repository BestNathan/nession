#!/usr/bin/env node
'use strict';

// Main-owned one-off Task contract. Secret access is opt-in and must be gated
// by a fresh GitHub authenticated Write+ actor check in the trusted workflow.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ENTRY_SEGMENT = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
const MAX_BYTES = 262144;
const MAX_FILES = 32;
const PERMITTED_SECRETS = new Set(['TYPESAFE_API_KEY']);
const TRUSTED_REPOSITORY_PERMISSIONS = new Set(['admin', 'write', 'maintain']);
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function die(message) { throw new Error('Task contract violation: ' + message); }
function readJson(file, maxBytes = 16384) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maxBytes) die('invalid JSON input size/type: ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function walk(root) {
  const taskRoot = path.join(root, '.task');
  if (!fs.existsSync(taskRoot) || !fs.lstatSync(taskRoot).isDirectory()) die('missing real .task directory');
  const files = [];
  let total = 0;
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.' || entry.name === '..' || !ENTRY_SEGMENT.test(entry.name)) die('invalid Task source filename');
      const abs = path.join(dir, entry.name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) die('Task source symlink forbidden: ' + abs);
      if (stat.isDirectory()) visit(abs);
      else if (stat.isFile()) {
        if (++total > MAX_FILES) die('too many Task source files');
        if (stat.size > MAX_BYTES) die('oversized Task source file');
        files.push({ name: path.relative(taskRoot, abs).split(path.sep).join('/'), bytes: fs.readFileSync(abs) });
      } else die('non-regular Task source');
    }
  }
  visit(taskRoot);
  if (files.reduce((n, f) => n + f.bytes.length, 0) > MAX_BYTES) die('Task source too large');
  files.sort((a,b) => a.name.localeCompare(b.name));
  return files;
}
function inspect(repo, expectedId) {
  const files = walk(repo);
  const manifestEntry = files.find((f) => f.name === 'task.json');
  if (!manifestEntry || manifestEntry.bytes.length > 16384) die('missing/big task.json');
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') die('invalid manifest');
  const allowed = new Set(['schema_version', 'id', 'runtime', 'entry', 'timeout_minutes', 'args', 'cleanup_on_success', 'secrets']);
  if (Object.keys(manifest).some((key) => !allowed.has(key))) die('unexpected manifest property');
  if (manifest.schema_version !== 1 || !ID.test(manifest.id || '') ||
      manifest.runtime !== 'node24' || !Number.isInteger(manifest.timeout_minutes) ||
      manifest.timeout_minutes < 1 || manifest.timeout_minutes > 30) die('unsupported Task manifest');
  if (expectedId && expectedId !== manifest.id) die('Task ID does not match requested task');
  const parts = String(manifest.entry || '').split('/');
  if (!parts.length || parts.some((part) => !ENTRY_SEGMENT.test(part) || part === '.' || part === '..') ||
      !/\.(?:mjs|cjs|js)$/.test(manifest.entry)) die('invalid script entry');
  if (!files.some((f) => f.name === manifest.entry)) die('script entry missing from Task source');
  if (manifest.cleanup_on_success !== undefined && typeof manifest.cleanup_on_success !== 'boolean') die('invalid cleanup policy');
  if (manifest.args === null || Array.isArray(manifest.args) || typeof manifest.args !== 'object' ||
      JSON.stringify(manifest.args).length > 8192) die('invalid Task args');
  if (manifest.secrets !== undefined &&
      (!Array.isArray(manifest.secrets) || manifest.secrets.length > PERMITTED_SECRETS.size ||
       manifest.secrets.some(name => typeof name !== 'string' || !PERMITTED_SECRETS.has(name)) ||
       new Set(manifest.secrets).size !== manifest.secrets.length)) {
    die('unsupported or duplicate Task secret request');
  }
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.name, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(file.bytes);
    hash.update(Buffer.from([0]));
  }
  return { manifest, files, source_digest: hash.digest('hex') };
}
function headSha(repo) {
  return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
function sourceSnapshot(checked, sha) {
  return {
    schema_version: 1,
    task_id: checked.manifest.id,
    source_sha: sha,
    source_digest: checked.source_digest,
    files: checked.files.map((f) => ({ path: f.name, base64: f.bytes.toString('base64') })),
  };
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function trustedPermission(permission) {
  return TRUSTED_REPOSITORY_PERMISSIONS.has(permission);
}
function validHumanActor(actor) {
  return ACTOR.test(actor || '') && !actor.toLowerCase().endsWith('[bot]');
}
async function lookupActorPermission(repository, actor, token) {
  const [owner, name, extra] = (repository || '').split('/');
  if (!owner || !name || extra || !validHumanActor(actor) || !token) return null;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(actor)}/permission`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
      }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.permission || null;
  } catch {
    return null; // Fail closed; do not infer Write permission from commit metadata.
  }
}
async function checkActorTrust() {
  const repository = process.env.GITHUB_REPOSITORY;
  const primary = process.env.GITHUB_ACTOR;
  const retrigger = process.env.GITHUB_TRIGGERING_ACTOR;
  const token = process.env.GH_TOKEN;
  const actors = [...new Set([primary, retrigger])];
  let trusted = !!repository && !!token && actors.every(validHumanActor);
  const permissions = [];
  if (trusted) {
    for (const actor of actors) {
      const permission = await lookupActorPermission(repository, actor, token);
      permissions.push({ actor, permission });
      if (!trustedPermission(permission)) trusted = false;
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'trusted=' + trusted + '\n');
  }
  console.log('Task submitter permission decision: ' + (trusted ? 'Write+ approved' : 'untrusted / read-only'));
  return trusted;
}
function decideCredentialMode(manifest, trusted) {
  const requested = manifest.secrets || [];
  if (requested.length && !trusted) die('Task requested secrets without GitHub Write+ actor permission');
  return requested.length ? 'credentialed' : 'ordinary';
}
function prepareRun(repo, sha, id) {
  if (!SHA.test(sha) || headSha(repo) !== sha) die('requested SHA differs from checked-out source');
  const checked = inspect(repo, id);
  const mode = decideCredentialMode(checked.manifest, process.env.TASK_ACTOR_TRUSTED === 'true');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'credentialed=' + (mode === 'credentialed') + '\n');
  }
  console.log('Task execution route: ' + mode);
}

function execute(repo, sha, id, out) {
  if (!SHA.test(sha) || headSha(repo) !== sha) die('requested SHA differs from checked-out source');
  const checked = inspect(repo, id);
  fs.mkdirSync(out, { recursive: true });
  const resultPath = path.join(out, 'result-input.json');
  const started = new Date().toISOString();
  const env = {
    PATH: process.env.PATH || '', HOME: process.env.HOME || os.tmpdir(),
    TMPDIR: process.env.RUNNER_TEMP || os.tmpdir(), CI: 'true',
    TASK_ID: checked.manifest.id, TASK_SOURCE_SHA: sha,
    TASK_ARGS_JSON: JSON.stringify(checked.manifest.args),
    TASK_OUTPUT_DIR: out, TASK_RESULT_PATH: resultPath,
  };
  const requestedSecrets = checked.manifest.secrets || [];
  if (requestedSecrets.length) {
    // This gate is in addition to (not instead of) the main-owned workflow actor check.
    // Never inherit the parent environment wholesale.
    if (process.env.TASK_APPROVED_SECRETS !== requestedSecrets.join(',')) {
      die('credentialed Task was not admitted by the trusted runner');
    }
    for (const name of requestedSecrets) {
      if (!process.env[name]) die('requested Task secret not configured: ' + name);
      env[name] = process.env[name];
    }
  }
  const child = spawnSync(process.execPath, [path.join(repo, '.task', ...checked.manifest.entry.split('/'))], {
    cwd: repo, env, encoding: 'utf8', timeout: checked.manifest.timeout_minutes * 60000,
    maxBuffer: 1024 * 1024,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  const success = !child.error && child.status === 0;
  let scriptResult = null;
  try {
    if (fs.existsSync(resultPath)) scriptResult = readJson(resultPath, 32768);
  } catch (error) {
    console.error('Task result rejected: ' + error.message);
    scriptResult = { error: 'Invalid structured result' };
  }
  const record = {
    schema_version: 1, task_id: checked.manifest.id, source_sha: sha,
    source_digest: checked.source_digest, entry: checked.manifest.entry,
    run_id: String(process.env.GITHUB_RUN_ID || '0'),
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT || '1'),
    started_at: started, finished_at: new Date().toISOString(),
    status: success ? 'Success' : 'Failed',
    exit_code: child.status, result: scriptResult,
  };
  writeJson(path.join(out, 'record.json'), record);
  console.log('Task ' + record.task_id + ' ' + record.status + ' at ' + sha);
  if (child.error) console.error('Task process error: ' + child.error.message);
  return success ? 0 : 1;
}
function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-task-selftest-'));
  try {
    fs.mkdirSync(path.join(root, '.task'));
    const valid = { schema_version: 1, id: 'task-test', runtime: 'node24',
      entry: 'execute.mjs', timeout_minutes: 10, args: { value: 1 } };
    fs.writeFileSync(path.join(root, '.task/task.json'), JSON.stringify(valid));
    fs.writeFileSync(path.join(root, '.task/execute.mjs'), 'process.exit(0)');
    const good = inspect(root, 'task-test');
    assert.match(good.source_digest, /^[0-9a-f]{64}$/);
    assert.equal(sourceSnapshot(good, 'a'.repeat(40)).files.length, 2);
    assert.throws(() => inspect(root, 'wrong-id'), /Task ID/);
    for (const entry of ['../oops.mjs','/etc/passwd','nested/../../oops.mjs']) {
      fs.writeFileSync(path.join(root, '.task/task.json'), JSON.stringify({ ...valid, entry }));
      assert.throws(() => inspect(root, 'task-test'), /invalid script entry/);
    }
    for (const runtime of ['bash','python','node20']) {
      fs.writeFileSync(path.join(root, '.task/task.json'), JSON.stringify({ ...valid, runtime }));
      assert.throws(() => inspect(root, 'task-test'), /unsupported Task manifest/);
    }
    fs.writeFileSync(path.join(root, '.task/task.json'), JSON.stringify({...valid, cleanup_on_success: 'unsafe'}));
    assert.throws(() => inspect(root, 'task-test'), /invalid cleanup policy/);
    assert.equal(decideCredentialMode(valid, false), 'ordinary');
    assert.equal(decideCredentialMode({...valid, secrets: ['TYPESAFE_API_KEY']}, true), 'credentialed');
    assert.throws(() => decideCredentialMode({...valid, secrets: ['TYPESAFE_API_KEY']}, false), /Write\+/);
    for (const invalidSecrets of [['UNKNOWN_SECRET'], ['TYPESAFE_API_KEY', 'TYPESAFE_API_KEY'], 'TYPESAFE_API_KEY']) {
      fs.writeFileSync(path.join(root, '.task/task.json'), JSON.stringify({ ...valid, secrets: invalidSecrets }));
      assert.throws(() => inspect(root, 'task-test'), /unsupported or duplicate Task secret request/);
    }
    assert.equal(trustedPermission('admin'), true);
    assert.equal(trustedPermission('write'), true);
    assert.equal(trustedPermission('read'), false);
    assert.equal(trustedPermission('triage'), false);
    assert.equal(trustedPermission(null), false);
    assert.equal(validHumanActor('github-actions[bot]'), false);
    assert.equal(validHumanActor('BestNathan'), true);
    fs.writeFileSync(path.join(root, '.task/task.json'), JSON.stringify(valid));
    fs.symlinkSync(path.join(root, '.task/execute.mjs'), path.join(root, '.task/bad.mjs'));
    assert.throws(() => inspect(root, 'task-test'), /symlink forbidden/);
    fs.unlinkSync(path.join(root, '.task/bad.mjs'));
    fs.unlinkSync(path.join(root, '.task/execute.mjs'));
    assert.throws(() => inspect(root, 'task-test'), /script entry missing/);
    console.log('Task runner positive and negative self-tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'self-test') return selfTest();
  if (command === 'actor-trust' && args.length === 0) return checkActorTrust();
  if (command === 'route' && args.length === 3) {
    return prepareRun(path.resolve(args[0]), args[1], args[2]);
  }
  if (command === 'execute' && args.length === 4) {
    process.exitCode = execute(path.resolve(args[0]), args[1], args[2], path.resolve(args[3]));
    return;
  }
  if (command === 'inspect' && args.length === 3) {
    const repo = path.resolve(args[0]), sha = args[1];
    if (!SHA.test(sha) || headSha(repo) !== sha) die('source SHA mismatch');
    console.log(JSON.stringify(sourceSnapshot(inspect(repo, args[2]), sha)));
    return;
  }
  die('usage: task-runner.mjs self-test|actor-trust|route REPO SHA ID|execute REPO SHA ID OUTPUT|inspect REPO SHA ID');
}
main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 2; });
