#!/usr/bin/env node
/**
 * #1876: exact-SHA Web dist transport, NOT an acceptance or build Pass proof.
 * The consumer separately verifies GitHub's completed successful main-push
 * Quality Gate run before invoking restore. Neither node_modules nor any
 * dev/preview dependencies are included in this artifact.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VERSION = 1;
const SHA = /^[a-f0-9]{40}$/;
const REPO = 'BestNathan/nession';
const WORKFLOW = '.github/workflows/ci-quality.yml';
const argv = process.argv.slice(2);

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
function npmVersion() { return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(); }
function arg(name, optional = false) {
  const i = argv.indexOf('--' + name);
  if (i < 0 || !argv[i + 1]) {
    if (optional) return null;
    throw Error('missing --' + name);
  }
  return argv[i + 1];
}
function int(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw Error('invalid ' + name);
  return n;
}
function envDigest(env = process.env) {
  // Vite's public build-time inputs; values are hashed, not emitted into logs.
  const inputs = Object.entries(env).filter(([k]) => k.startsWith('VITE_'))
    .sort(([a], [b]) => a.localeCompare(b));
  return hash(JSON.stringify(inputs));
}
function assertNoLocalEnv(web) {
  // Vite loads these automatically, outside of process.env; their values could
  // alter the build without changing the commit tree. Do not publish/reuse.
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    if (existsSync(path.join(web, name))) throw Error('untracked Vite build inputs: ' + name);
  }
}
function context(root, env = process.env) {
  root = path.resolve(root);
  const web = path.join(root, 'web');
  assertNoLocalEnv(web);
  const sha = git(root, 'rev-parse', 'HEAD');
  if (!SHA.test(sha)) throw Error('invalid checkout SHA');
  return {
    sha,
    web_tree: git(root, 'rev-parse', 'HEAD:web'),
    node: process.version,
    npm: npmVersion(),
    platform: process.platform,
    arch: process.arch,
    vite_env_sha256: envDigest(env),
  };
}
function walk(directory, prefix = '') {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) throw Error('missing directory: ' + directory);
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('unsafe dist entry: ' + file);
    const relative = prefix ? prefix + '/' + name : name;
    if (stat.isDirectory()) entries.push(...walk(file, relative));
    else entries.push({ path: relative, sha256: hash(readFileSync(file)), bytes: stat.size });
  }
  return entries;
}
function assertDist(web, entries) {
  const files = new Set(entries.map(x => x.path));
  if (!files.has('index.html')) throw Error('dist lacks index.html');
  const packageJson = JSON.parse(readFileSync(path.join(web, 'package.json'), 'utf8'));
  const fontNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
    .filter(x => x.startsWith('@fontsource')).sort();
  if (!fontNames.length) throw Error('no bundled font packages');
  for (const name of fontNames) {
    const license = 'licenses/' + name.replace(/[@/]/g, '-').replace(/^-/, '') + '.txt';
    if (!files.has(license)) throw Error('missing bundled font license ' + license);
  }
  if (!entries.some(x => x.path.endsWith('.woff2'))) throw Error('dist lacks bundled font files');
  if (entries.length > 10000) throw Error('unbounded dist contents');
}
function manifest(root, env, runId, runAttempt) {
  const c = context(root, env), web = path.join(root, 'web');
  const files = walk(path.join(web, 'dist'));
  assertDist(web, files);
  return { schema_version: VERSION, kind: 'web_build_dist', repository: REPO,
    producer: { workflow: WORKFLOW, run_id: int(runId, 'run_id'), run_attempt: int(runAttempt, 'run_attempt'), event: 'push', branch: 'main' },
    input: c, files,
    files_sha256: hash(JSON.stringify(files)) };
}
function pack({ root, dest, env = process.env }) {
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main' ||
      env.GITHUB_SHA !== git(root, 'rev-parse', 'HEAD')) throw Error('producer is not the exact main push checkout');
  const record = manifest(root, env, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
  dest = path.resolve(dest);
  if (existsSync(dest) && readdirSync(dest).length) throw Error('artifact directory not empty');
  mkdirSync(dest, { recursive: true });
  cpSync(path.join(root, 'web', 'dist'), path.join(dest, 'dist'), { recursive: true, dereference: false });
  writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}
function restore({ root, source, sha, runId, runAttempt, env = process.env }) {
  root = path.resolve(root); source = path.resolve(source);
  const raw = readFileSync(path.join(source, 'manifest.json'), 'utf8');
  if (raw.length > 5_000_000) throw Error('manifest too large');
  const m = JSON.parse(raw), current = context(root, env);
  if (m.schema_version !== VERSION || m.kind !== 'web_build_dist' || m.repository !== REPO ||
      m.producer?.workflow !== WORKFLOW || m.producer?.event !== 'push' || m.producer?.branch !== 'main' ||
      m.producer?.run_id !== int(runId, 'producer run id') ||
      m.producer?.run_attempt !== int(runAttempt, 'producer attempt') ||
      !SHA.test(sha) || sha !== current.sha ||
      JSON.stringify(m.input) !== JSON.stringify(current)) throw Error('untrusted or mismatched Web artifact provenance');
  if (!Array.isArray(m.files) || m.files.length < 3 || m.files.length > 10000 ||
      m.files_sha256 !== hash(JSON.stringify(m.files))) throw Error('invalid manifest integrity');
  const actual = walk(path.join(source, 'dist'));
  assertDist(path.join(root, 'web'), actual);
  if (JSON.stringify(m.files) !== JSON.stringify(actual)) throw Error('dist checksum/content mismatch');
  const target = path.join(root, 'web', 'dist');
  const staged = path.join(root, 'web', '.dist-verified-' + process.pid);
  if (existsSync(staged)) throw Error('staging destination already exists');
  try {
    cpSync(path.join(source, 'dist'), staged, { recursive: true, dereference: false });
    if (JSON.stringify(walk(staged)) !== JSON.stringify(actual)) throw Error('staging dist verification failed');
    // Replace only after ALL checks passed; callers fall back to fresh builds on failure.
    rmSync(target, { recursive: true, force: true });
    renameSync(staged, target);
  } finally { rmSync(staged, { recursive: true, force: true }); }
  return m;
}
function selfTest() {
  const temp = mkdtempSync(path.join(tmpdir(), 'nession-web-artifact-'));
  try {
    const root = path.join(temp, 'repo');
    mkdirSync(path.join(root, 'web', 'dist', 'licenses'), { recursive: true });
    mkdirSync(path.join(root, 'web', 'dist', 'assets'), { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(path.join(root, 'web', 'package.json'), JSON.stringify({ dependencies: { '@fontsource-variable/inter': '1' } }));
    writeFileSync(path.join(root, 'web', 'dist', 'index.html'), '<html></html>');
    writeFileSync(path.join(root, 'web', 'dist', 'assets', 'font.woff2'), 'woff2');
    writeFileSync(path.join(root, 'web', 'dist', 'licenses', 'fontsource-variable-inter.txt'), 'OFL');
    execFileSync('git', ['-C', root, 'add', 'web/package.json']);
    execFileSync('git', ['-C', root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=test', 'commit', '-qm', 'fixture']);
    const sha = git(root, 'rev-parse', 'HEAD');
    const env = { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '2' };
    const out = path.join(temp, 'artifact');
    const m = pack({ root, dest: out, env });
    assert.equal(m.input.sha, sha);
    rmSync(path.join(root, 'web', 'dist'), { recursive: true });
    restore({ root, source: out, sha, runId: 17, runAttempt: 2, env });
    assert.ok(existsSync(path.join(root, 'web', 'dist', 'index.html')));
    assert.throws(() => restore({ root, source: out, sha: 'b'.repeat(40), runId: 17, runAttempt: 2, env }), /mismatched/);
    assert.throws(() => restore({ root, source: out, sha, runId: 99, runAttempt: 2, env }), /mismatched/);
    writeFileSync(path.join(out, 'dist', 'index.html'), 'tamper');
    assert.throws(() => restore({ root, source: out, sha, runId: 17, runAttempt: 2, env }), /checksum/);
    assert.equal(readFileSync(path.join(root, 'web', 'dist', 'index.html'), 'utf8'), '<html></html>');
    writeFileSync(path.join(root, 'web', '.env.production'), 'VITE_SECRET=x');
    assert.throws(() => context(root, env), /untracked Vite/);
    console.log('web-build-artifact self-test: roundtrip, SHA, producer, tamper and env negatives pass');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (argv[0] === 'self-test') selfTest();
else if (argv[0] === 'pack') {
  const root = path.resolve(arg('root')), dest = path.resolve(arg('dest'));
  const m = pack({ root, dest });
  console.log('WEB_BUILD_ARTIFACT_V1 ' + JSON.stringify({ sha: m.input.sha, run_id: m.producer.run_id,
    run_attempt: m.producer.run_attempt, files: m.files.length, files_sha256: m.files_sha256 }));
} else if (argv[0] === 'restore') {
  const m = restore({ root: path.resolve(arg('root')), source: path.resolve(arg('source')),
    sha: arg('sha'), runId: arg('run-id'), runAttempt: arg('attempt') });
  console.log('WEB_BUILD_REUSE_V1 ' + JSON.stringify({ status: 'hit', sha: m.input.sha,
    producer_run_id: m.producer.run_id, producer_attempt: m.producer.run_attempt,
    files: m.files.length, files_sha256: m.files_sha256 }));
} else { console.error('usage: web-build-artifact.mjs self-test | pack --root ROOT --dest DIR | restore --root ROOT --source DIR --sha SHA --run-id ID --attempt ATTEMPT'); process.exitCode = 2; }
