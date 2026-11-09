#!/usr/bin/env node
// Trusted-main owner of bounded, criterion-scoped, read-only orphan evidence.
// Never execute target checkout files or allow model-selected refs or paths.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractSection } from './requirement-acceptance.mjs';

const BRANCHES = Object.freeze({
  prototype: (p) => /^[a-z0-9][a-z0-9-]*-\d{2,}\//.test(p),
  knowledge: (p) => /^(topics\/|schema\/|index\.json$|CHANGELOG\.md$)/.test(p),
  gitops: (p) => /^(base\/|argocd\/|environments\/)/.test(p) &&
    !/(^|\/)(?:secret|secrets|credential|credentials|token|tokens|sealedsecret|private)(?:[-_.\/]|$)/i.test(p),
});
const TEXT_EXT = /\.(?:md|markdown|txt|html|css|js|mjs|ts|tsx|json|yaml|yml|svg)$/i;
const MAX_FILES = 128;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_ROOT = '.nession-acceptance-sources';

const digest = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
function reject(reason) { throw new Error('Acceptance Sources: ' + reason); }
function validPath(p, branch) {
  if (typeof p !== 'string' || p.length > 240 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(p) ||
      p.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      p.includes('//') || !TEXT_EXT.test(p) || !BRANCHES[branch](p)) {
    reject('disallowed ' + branch + ' path ' + JSON.stringify(p));
  }
  return p;
}

// A deliberate small YAML subset; no aliases, maps, comments, quoted scalars,
// arbitrary keys, globbing or object deserialization.
export function parseAcceptanceSources(body, criteria, plan) {
  const section = extractSection(String(body ?? ''), 'Acceptance Sources');
  if (section == null) return null;
  const lines = section.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.shift() !== 'acceptance_sources:') reject('expected acceptance_sources: root');
  const allowed = new Set(criteria);
  const result = new Map();
  let id = null;
  let entry = null;
  let inFiles = false;
  for (const line of lines) {
    if (line.includes('\t')) reject('tabs are not supported');
    let m;
    if ((m = /^  (SC-\d{2,}):$/.exec(line))) {
      id = m[1];
      if (!allowed.has(id)) reject('unknown criterion ' + id);
      if (plan?.get(id)?.method !== 'agent') reject(id + ' must have an Agent Acceptance Plan');
      if (result.has(id)) reject('duplicate criterion ' + id);
      result.set(id, []);
      entry = null;
      inFiles = false;
    } else if ((m = /^    - branch: (prototype|knowledge|gitops)$/.exec(line))) {
      if (!id) reject('source entry without criterion');
      if (result.get(id).length >= 2) reject(id + ' exceeds two source entries');
      entry = { branch: m[1], sha: null, files: [] };
      result.get(id).push(entry);
      inFiles = false;
    } else if ((m = /^      sha: ([0-9a-f]{40})$/.exec(line))) {
      if (!entry || entry.sha || inFiles) reject('invalid or duplicate sha');
      entry.sha = m[1];
    } else if (line === '      files:') {
      if (!entry || !entry.sha || inFiles) reject('files must follow sha once');
      inFiles = true;
    } else if ((m = /^        - ([A-Za-z0-9][A-Za-z0-9_.\/-]*)$/.exec(line))) {
      if (!entry || !inFiles) reject('file outside files list');
      if (entry.files.length >= 8) reject('more than eight files in an entry');
      const p = validPath(m[1], entry.branch);
      if (entry.files.includes(p)) reject('duplicate path ' + p);
      entry.files.push(p);
    } else {
      reject('unsupported declaration line ' + JSON.stringify(line));
    }
  }
  if (!result.size) reject('empty source declaration');
  const normalized = {};
  for (const [sc, entries] of [...result].sort(([a], [b]) => a.localeCompare(b))) {
    for (const item of entries) {
      if (!item.sha || !item.files.length) reject(sc + ' has incomplete source entry');
      item.files.sort();
    }
    const keys = entries.map((e) => e.branch + '@' + e.sha + ':' + e.files.join(','));
    if (new Set(keys).size !== keys.length) reject(sc + ' has duplicated source entry');
    normalized[sc] = entries.sort((a, b) =>
      (a.branch + a.sha).localeCompare(b.branch + b.sha));
  }
  return normalized;
}

export function sourceDigestExtension(sources) {
  return sources ? { acceptance_sources: sources } : null;
}

function git(workspace, ...args) {
  return execFileSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024,
  }).trim();
}

function readAtCommit(workspace, source) {
  const ref = 'refs/remotes/origin/' + source.branch;
  try {
    git(workspace, 'rev-parse', '--verify', ref + '^{commit}');
    git(workspace, 'cat-file', '-e', source.sha + '^{commit}');
    git(workspace, 'merge-base', '--is-ancestor', source.sha, ref);
  } catch {
    reject(source.branch + '@' + source.sha + ' is missing or not reachable from approved branch');
  }
  const output = [];
  for (const p of source.files) {
    const listing = git(workspace, 'ls-tree', '-rz', source.sha, '--', p);
    const records = listing.split('\0').filter(Boolean);
    if (records.length !== 1) reject('missing/non-regular Git tree entry ' + source.branch + ':' + p);
    const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(records[0]);
    if (!match || match[2] !== p) reject('unsafe Git tree mode/path ' + source.branch + ':' + p);
    const size = Number(git(workspace, 'cat-file', '-s', match[1]));
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) reject('oversized source file ' + p);
    const bytes = execFileSync('git', ['-C', workspace, 'cat-file', 'blob', match[1]], {
      maxBuffer: MAX_FILE_BYTES + 4096,
    });
    if (bytes.length !== size || bytes.includes(0)) reject('non-text content ' + p);
    let decoded;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { reject('non-UTF8 source ' + p); }
    if (/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(decoded)) reject('control bytes in source ' + p);
    output.push({ branch: source.branch, sha: source.sha, path: p,
      bytes, size, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  return output;
}

export function sourceCitation(entry) {
  return entry.branch + '@' + entry.sha + ':' + entry.path + '#sha256=' + entry.sha256;
}
export function validateSourceEvidence(context, criterion) {
  const selected = context.acceptance_sources?.[criterion.criterion];
  const citations = criterion.evidence.filter((item) => item.type === 'source');
  if (!selected && citations.length) reject(criterion.criterion + ' supplied an undeclared source citation');
  if (criterion.result !== 'Pass' || !selected) return;
  const manifest = context.source_manifest;
  if (!manifest || !SHA256.test(manifest.sha256) || !Array.isArray(manifest.entries)) {
    reject(criterion.criterion + ' source manifest is missing');
  }
  const allowed = new Set(manifest.entries
    .filter((entry) => entry.criterion === criterion.criterion).map(sourceCitation));
  if (!citations.length) reject(criterion.criterion + ' Pass requires a source citation');
  for (const item of citations) {
    if (!allowed.has(item.value)) reject(criterion.criterion + ' forged or undeclared source citation');
  }
}

export function materializeSources(context, workspace) {
  const selected = new Set(context.criteria.map((item) => item.criterion));
  const requests = Object.entries(context.acceptance_sources ?? {})
    .filter(([criterion]) => selected.has(criterion));
  if (!requests.length) return null;
  if (!fs.statSync(workspace).isDirectory()) reject('workspace must be a directory');
  const root = path.join(workspace, SOURCE_ROOT);
  try {
    fs.lstatSync(root);
    reject('reserved staging root already exists in target checkout');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Validate ALL requested sources before publishing ANY generated evidence.
  const entries = [];
  let combined = 0;
  for (const [criterion, sources] of requests) {
    for (const source of sources) {
      for (const file of readAtCommit(workspace, source)) {
        if (++combined > MAX_FILES) reject('combined source file budget exceeded');
        entries.push({ criterion, ...file });
      }
    }
  }
  const size = entries.reduce((total, entry) => total + entry.size, 0);
  if (size > MAX_BYTES) reject('combined source byte budget exceeded');
  fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  try {
    for (const entry of entries) {
      const rel = path.join(entry.criterion, entry.branch, entry.path);
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, entry.bytes, { flag: 'wx', mode: 0o400 });
      entry.staged_path = SOURCE_ROOT + '/' + rel.replaceAll(path.sep, '/');
      delete entry.bytes;
    }
    const manifestEntries = entries.map((e) => ({ ...e }));
    // Lock generated subdirectories only after all writes are complete.
    const directories = new Set(entries.map((e) => path.dirname(path.join(root, e.staged_path.slice(SOURCE_ROOT.length + 1)))));
    for (const dir of [...directories].sort((a, b) => b.length - a.length)) fs.chmodSync(dir, 0o500);
    const manifest = {
      schema_version: 1, issue: context.issue.number,
      target_ref: context.target_ref, contract_sha256: context.contract_sha256,
      entries: manifestEntries,
    };
    manifest.sha256 = digest(manifest);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o400 });
    fs.chmodSync(root, 0o500);
    return manifest;
  } catch (error) {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function selfTest() {
  const body = ['## Requirements: fixture', '### Success Criteria', '- [ ] SC-01 source',
    '## Acceptance Sources', 'acceptance_sources:', '  SC-01:',
    '    - branch: prototype', '      sha: ' + 'a'.repeat(40),
    '      files:', '        - demo-123/index.html',
    '## Acceptance Report', '| Criterion | Result | Evidence |', '|---|---|---|',
    '| SC-01 | Pending | - |'].join('\n');
  const source = parseAcceptanceSources(body, ['SC-01'], new Map([['SC-01', { method: 'agent' }]]));
  assert.equal(source['SC-01'][0].files[0], 'demo-123/index.html');
  assert.equal(parseAcceptanceSources(body.replace('## Acceptance Sources', '## Not Sources'),
    ['SC-01'], new Map()), null);
  const rejectBody = (next) => assert.throws(() =>
    parseAcceptanceSources(next, ['SC-01'], new Map([['SC-01', { method: 'agent' }]])),
    /Acceptance Sources:/);
  rejectBody(body.replace('prototype', 'metrics'));
  rejectBody(body.replace('demo-123/index.html', '../secret.md'));
  rejectBody(body.replace('demo-123/index.html', 'other/private.pem'));
  rejectBody(body.replace('a'.repeat(40), 'branch-head'));
  rejectBody(body.replace('        - demo-123/index.html', '        - demo-123/index.html\n        - demo-123/index.html'));
  rejectBody(body.replace('  SC-01:', '  SC-99:'));
  const item = { criterion: 'SC-01', branch: 'prototype', sha: 'a'.repeat(40),
    path: 'demo-123/index.html', sha256: 'b'.repeat(64) };
  const context = { acceptance_sources: source,
    source_manifest: { sha256: 'c'.repeat(40), entries: [item] } };
  const pass = { criterion: 'SC-01', result: 'Pass',
    evidence: [{ type: 'source', value: sourceCitation(item) }] };
  validateSourceEvidence(context, pass);
  assert.throws(() => validateSourceEvidence(context, { ...pass, evidence: [] }), /source citation/);
  assert.throws(() => validateSourceEvidence(context, { ...pass,
    evidence: [{ type: 'source', value: 'forged' }] }), /forged/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-source-selftest-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'Acceptance fixture');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    fs.mkdirSync(path.join(dir, 'demo-123'));
    fs.writeFileSync(path.join(dir, 'demo-123/index.html'), '<html>pinned</html>\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'pinned fixture');
    const originalSha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/prototype', originalSha);
    const plan = new Map([['SC-01', { method: 'agent' }]]);
    const localDeclaration = parseAcceptanceSources(
      body.replace('a'.repeat(40), originalSha), ['SC-01'], plan);
    const localContext = {
      issue: { number: 1 }, target_ref: originalSha,
      contract_sha256: 'd'.repeat(64),
      criteria: [{ criterion: 'SC-01' }], acceptance_sources: localDeclaration,
    };
    const published = materializeSources(localContext, dir);
    assert.equal(published.entries.length, 1);
    assert.equal(published.entries[0].sha, originalSha);
    assert.equal(fs.readFileSync(path.join(dir, SOURCE_ROOT, 'SC-01/prototype/demo-123/index.html'), 'utf8'),
      '<html>pinned</html>\n');
    assert.throws(() => materializeSources(localContext, dir), /reserved staging root already exists/);
    fs.chmodSync(path.join(dir, SOURCE_ROOT), 0o700);
    fs.chmodSync(path.join(dir, SOURCE_ROOT, 'SC-01/prototype/demo-123'), 0o700);
    fs.chmodSync(path.join(dir, SOURCE_ROOT, 'SC-01/prototype'), 0o700);
    fs.chmodSync(path.join(dir, SOURCE_ROOT, 'SC-01'), 0o700);
    fs.rmSync(path.join(dir, SOURCE_ROOT), { recursive: true, force: true });
    // New tip does not retarget a pinned source.
    fs.writeFileSync(path.join(dir, 'demo-123/index.html'), '<html>moved</html>\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'new tip');
    git(dir, 'update-ref', 'refs/remotes/origin/prototype', git(dir, 'rev-parse', 'HEAD'));
    const pinned = materializeSources(localContext, dir);
    assert.equal(pinned.entries[0].sha256, published.entries[0].sha256);
    // An unrelated force-pushed tip cannot be mistaken for the approved source lineage.
    fs.chmodSync(path.join(dir, SOURCE_ROOT), 0o700);
    fs.chmodSync(path.join(dir, SOURCE_ROOT, 'SC-01/prototype/demo-123'), 0o700);
    fs.chmodSync(path.join(dir, SOURCE_ROOT, 'SC-01/prototype'), 0o700);
    fs.chmodSync(path.join(dir, SOURCE_ROOT, 'SC-01'), 0o700);
    fs.rmSync(path.join(dir, SOURCE_ROOT), { recursive: true, force: true });
    git(dir, 'checkout', '--orphan', 'unrelated');
    git(dir, 'rm', '-qr', '.');
    fs.mkdirSync(path.join(dir, 'demo-123'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'demo-123/index.html'), '<html>different</html>\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'unrelated tip');
    git(dir, 'update-ref', 'refs/remotes/origin/prototype', git(dir, 'rev-parse', 'HEAD'));
    assert.throws(() => materializeSources(localContext, dir), /not reachable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('acceptance-sources: parser, source materialization, drift and citation fixtures passed');
}

function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  if (process.argv[2] !== 'stage' || process.argv.length !== 5) {
    throw new Error('usage: acceptance-sources.mjs stage <context.json> <target-workspace>');
  }
  const contextFile = process.argv[3];
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  if (!context.acceptance_sources) return;
  const manifest = materializeSources(context, process.argv[4]);
  if (!manifest) return;
  context.source_manifest = { sha256: manifest.sha256, entries: manifest.entries };
  fs.writeFileSync(contextFile, JSON.stringify(context, null, 2) + '\n');
  console.log('staged ' + manifest.entries.length + ' pinned read-only Acceptance Source files');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
