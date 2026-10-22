import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveIdentity } from '../harness/contract.mjs';
import { checkpointPath, checkpointPrefix, unsealCheckpoint } from './checkpoint.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SOURCES = {
  '.github/workflows/agent-develop.yml': { role:'developer', name:'Agent / Development' },
  '.github/workflows/agent-review.yml': { role:'reviewer', name:'Agent / Review' },
  '.github/workflows/agent-sc-acceptance.yml': { role:'acceptor', name:'Agent / SC Acceptance' },
};
function reject(text) { throw new Error('agent store: ' + text); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function bytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
function safeDir(root, rel = '') {
  let dir = path.resolve(root);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) reject('unsafe store root');
  for (const part of rel.split('/').filter(Boolean)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(part) || ['.','..'].includes(part)) reject('unsafe path');
    dir = path.join(dir, part);
    if (fs.existsSync(dir)) {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) reject('unsafe intermediate directory');
    } else fs.mkdirSync(dir);
  }
  return dir;
}
function readJson(root, rel, max = 32 * 1024 * 1024) {
  const parent = safeDir(root, path.posix.dirname(rel));
  const file = path.join(parent, path.posix.basename(rel));
  if (!fs.existsSync(file)) return null;
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > max) reject('unsafe/nonregular file');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { reject('corrupt Store JSON'); }
}
function putImmutable(root, rel, value) {
  const dir = safeDir(root, path.posix.dirname(rel));
  const file = path.join(dir, path.posix.basename(rel));
  if (fs.existsSync(file)) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || !fs.readFileSync(file).equals(bytes(value))) reject('immutable collision');
    return false;
  }
  fs.writeFileSync(file, bytes(value), { flag:'wx', mode:0o600 });
  return true;
}
export function validateCheckpointSource(source, sealed, registry) {
  if (source?.repository !== 'BestNathan/nession' ||
      !Number.isSafeInteger(source.run_id) || source.run_id < 1 ||
      !Number.isSafeInteger(source.attempt) || source.attempt < 1 ||
      !Number.isSafeInteger(source.issue) || source.issue < 1 ||
      !HEX40.test(source.workflow_sha ?? '') || !HEX40.test(source.target_sha ?? '') ||
      source.head_branch !== 'main') reject('invalid trusted source identity');
  const owner = SOURCES[source.path];
  if (!owner || owner.name !== source.workflow_name || owner.role !== source.role ||
      !['workflow_dispatch','repository_dispatch','workflow_call'].includes(source.event)) {
    reject('untrusted source workflow');
  }
  const instance = resolveIdentity(registry, source.agent_id, source.task, source.environment);
  if (instance.role !== owner.role || instance.provider !== source.provider) reject('role/provider mismatch');
  const identity = { role:instance.role, agent_id:instance.agent_id, issue:source.issue };
  if (sealed?.schema_version !== 1 || sealed.kind !== 'encrypted_agent_checkpoint' ||
      !Number.isSafeInteger(sealed.version) || sealed.version < 1 ||
      sealed.path !== checkpointPath(identity, sealed.version) ||
      sealed.identity?.role !== identity.role || sealed.identity?.agent_id !== identity.agent_id ||
      sealed.identity?.issue !== identity.issue) reject('checkpoint path/identity mismatch');
  if (sealed.metadata?.provider !== source.provider ||
      sealed.metadata?.source_sha !== source.target_sha ||
      !HEX64.test(sealed.metadata?.harness_digest ?? '') ||
      typeof sealed.metadata.session_id !== 'string' ||
      !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(sealed.metadata.session_id)) reject('checkpoint metadata mismatch');
  if (typeof sealed.ciphertext !== 'string' || sealed.ciphertext.length > 24 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(sealed.ciphertext)) reject('invalid ciphertext encoding');
  const encrypted = Buffer.from(sealed.ciphertext, 'base64');
  if (encrypted.length < 1 || encrypted.length > 16 * 1024 * 1024 ||
      digest(encrypted) !== sealed.ciphertext_sha256) reject('ciphertext integrity mismatch');
  return identity;
}
function readHead(root, identity) {
  const base = checkpointPrefix(identity);
  const head = readJson(root, base + '/head.json', 8192);
  if (!head) return { version:0, checkpoint_path:null, ciphertext_sha256:null };
  if (!Number.isSafeInteger(head.version) || head.version < 1 ||
      head.checkpoint_path !== checkpointPath(identity, head.version) ||
      !HEX64.test(head.ciphertext_sha256 ?? '')) reject('invalid Store head');
  const current = readJson(root, head.checkpoint_path);
  if (!current || current.ciphertext_sha256 !== head.ciphertext_sha256) reject('dangling Store head');
  return head;
}
// Caller must supply independently verified GitHub source identity and keep
// the AES key in a trusted job, never in the untrusted Provider executor.
export function ingestEncryptedCheckpoint(root, source, sealed, registry, key, expectedVersion) {
  const identity = validateCheckpointSource(source, sealed, registry);
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) reject('missing authorized Store key');
  const plaintext = unsealCheckpoint(identity, sealed, key);
  try {
    const head = readHead(root, identity);
    if (expectedVersion !== head.version) {
      const already = readJson(root, sealed.path);
      const oldRun = readJson(root, checkpointPrefix(identity) + '/runs/' +
        source.run_id + '-' + source.attempt + '.json');
      if (already && oldRun && head.version === sealed.version &&
          oldRun.checkpoint_path === sealed.path && oldRun.ciphertext_sha256 === sealed.ciphertext_sha256 &&
          oldRun.source_sha === source.target_sha && oldRun.workflow_sha === source.workflow_sha &&
          bytes(already).equals(bytes(sealed))) {
        return { idempotent:true, identity, version:head.version };
      }
      reject('stale Store CAS version');
    }
    if (sealed.version !== head.version + 1) reject('checkpoint sequence gap');
    const base = checkpointPrefix(identity);
    const runPath = base + '/runs/' + source.run_id + '-' + source.attempt + '.json';
    const runRecord = {
      schema_version:1, kind:'agent_checkpoint_run', role:identity.role,
      agent_id:identity.agent_id, issue:identity.issue, run_id:source.run_id,
      attempt:source.attempt, source_sha:source.target_sha,
      workflow_sha:source.workflow_sha, workflow:source.path,
      checkpoint_path:sealed.path, version:sealed.version,
      ciphertext_sha256:sealed.ciphertext_sha256,
      harness_digest:sealed.metadata.harness_digest,
    };
    // Commit encrypted immutable objects first, then update head. The GitHub
    // writer is responsible for the orphan ref serialization/fast-forward lease.
    putImmutable(root, sealed.path, sealed);
    putImmutable(root, runPath, runRecord);
    const dir = safeDir(root, base);
    const next = { version:sealed.version, checkpoint_path:sealed.path,
      ciphertext_sha256:sealed.ciphertext_sha256 };
    const temporary = path.join(dir, '.head-' + source.run_id + '-' + source.attempt);
    if (fs.existsSync(temporary)) {
      const stat = fs.lstatSync(temporary);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          !fs.readFileSync(temporary).equals(bytes(next))) reject('conflicting unfinished checkpoint head');
    } else fs.writeFileSync(temporary, bytes(next), { flag:'wx', mode:0o600 });
    fs.renameSync(temporary, path.join(dir, 'head.json'));
    return { idempotent:false, identity, version:sealed.version, run_path:runPath };
  } finally { plaintext.fill(0); }
}
export function restoreEncryptedCheckpoint(root, identity, expected, key) {
  const head = readHead(root, identity);
  if (head.version < 1) reject('checkpoint not found');
  const record = readJson(root, head.checkpoint_path);
  if (record.metadata?.provider !== expected.provider ||
      record.metadata?.source_sha !== expected.source_sha ||
      record.metadata?.harness_digest !== expected.harness_digest) reject('checkpoint compatibility mismatch');
  return { head, native_bytes:unsealCheckpoint(identity, record, key) };
}
