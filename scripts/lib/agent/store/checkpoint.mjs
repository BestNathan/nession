import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ID = /^[a-z][a-z0-9-]*$/;
function reject(m) { throw new Error('agent checkpoint: ' + m); }
function validateIdentity(identity) {
  if (!ID.test(identity?.role ?? '') || !ID.test(identity?.agent_id ?? '') ||
      !Number.isInteger(identity?.issue) || identity.issue <= 0) reject('invalid checkpoint identity');
  return identity;
}
export function checkpointPrefix(identity) {
  validateIdentity(identity);
  return 'roles/' + identity.role + '/' + identity.agent_id + '/issues/' + identity.issue;
}
export function checkpointPath(identity, version) {
  if (!Number.isSafeInteger(version) || version < 1) reject('invalid checkpoint version');
  return checkpointPrefix(identity) + '/checkpoints/' + String(version).padStart(8, '0') + '.json';
}
function secretKey(key) {
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) reject('AES-256 key must be a 32-byte secret');
  return key;
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function authenticatedContext(location, metadata) {
  // Path prevents cross-Agent replay; metadata is authenticated as well,
  // so an attacker cannot rebind Provider session/Harness without the AES key.
  const fields = Object.entries(metadata ?? {}).sort(([a],[b]) => a.localeCompare(b));
  return Buffer.from(JSON.stringify({ path: location, metadata: Object.fromEntries(fields) }));
}

// All Provider-native checkpoint bytes are encrypted before touching Git or artifacts.
// The encryption key remains outside this repository and its orphan branches.
export function sealCheckpoint(identity, version, nativeBytes, key, metadata = {}) {
  validateIdentity(identity);
  const location = checkpointPath(identity, version);
  if (!Buffer.isBuffer(nativeBytes) || nativeBytes.byteLength === 0) reject('empty native checkpoint');
  if (Object.keys(metadata).some((k) => !['provider', 'session_id', 'source_sha', 'harness_digest'].includes(k))) {
    reject('unsafe checkpoint metadata');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(key), iv);
  const aad = authenticatedContext(location, metadata);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(nativeBytes), cipher.final()]);
  return {
    schema_version: 1, kind: 'encrypted_agent_checkpoint',
    path: location, identity: { role: identity.role, agent_id: identity.agent_id, issue: identity.issue },
    version, metadata,
    encryption: { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'), ciphertext_sha256: hash(ciphertext),
  };
}

export function unsealCheckpoint(identity, record, key) {
  validateIdentity(identity);
  if (record?.schema_version !== 1 || record.kind !== 'encrypted_agent_checkpoint' ||
      record.path !== checkpointPath(identity, record.version) ||
      record.identity?.role !== identity.role || record.identity?.agent_id !== identity.agent_id ||
      record.identity?.issue !== identity.issue || record.encryption?.algorithm !== 'aes-256-gcm') {
    reject('checkpoint identity or encryption mismatch');
  }
  const ciphertext = Buffer.from(record.ciphertext ?? '', 'base64');
  if (hash(ciphertext) !== record.ciphertext_sha256) reject('checkpoint ciphertext integrity mismatch');
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(key), Buffer.from(record.encryption.iv, 'base64'));
    decipher.setAAD(authenticatedContext(record.path, record.metadata));
    decipher.setAuthTag(Buffer.from(record.encryption.tag, 'base64'));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { reject('checkpoint authentication failed'); }
}

export function advanceCheckpointHead(current, expected, next) {
  if (current?.version !== expected?.version || current?.checkpoint_path !== expected?.checkpoint_path) {
    reject('stale checkpoint head (compare-and-swap failed)');
  }
  if (!next || !Number.isInteger(next.version) || next.version !== (current?.version ?? 0) + 1 ||
      !/\/checkpoints\/\d{8}\.json$/.test(next.checkpoint_path ?? '')) reject('invalid checkpoint successor');
  return Object.freeze({ version: next.version, checkpoint_path: next.checkpoint_path });
}
