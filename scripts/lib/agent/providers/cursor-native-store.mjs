// Native Cursor JSONL snapshot transport for the bounded #1664 resume fixture.
// Never upload the plaintext native store: seal before Actions Artifact creation.
import fs from 'node:fs';
import path from 'node:path';
import {
  createCipheriv, createDecipheriv, createPublicKey, createPrivateKey,
  publicEncrypt, privateDecrypt, randomBytes, createHash, constants,
} from 'node:crypto';

const FILES = Object.freeze(['agents.ndjson','checkpoints.ndjson','runs.ndjson','run_events.ndjson']);
const SHA40 = /^[a-f0-9]{40}$/, SHA64 = /^[a-f0-9]{64}$/;
const AGENT = /^agent-[a-zA-Z0-9-]{4,100}$/;
const MAX_NATIVE = 16 * 1024 * 1024;
const hash = b => createHash('sha256').update(b).digest('hex');
function fail(message) { throw new Error('Cursor native checkpoint: ' + message); }
function valid(meta) {
  if (!meta || !AGENT.test(meta.agent_id ?? '') || !SHA40.test(meta.source_sha ?? '') ||
      !SHA64.test(meta.harness_digest ?? '') ||
      !Number.isSafeInteger(meta.run_id) || meta.run_id < 1 ||
      !Number.isSafeInteger(meta.attempt) || meta.attempt < 1 ||
      typeof meta.sdk_version !== 'string' || !/^[a-zA-Z0-9.+-]{1,80}$/.test(meta.sdk_version)) {
    fail('invalid native checkpoint origin or compatibility metadata');
  }
  return meta;
}
function strictFiles(dir) {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) {
    fail('native store directory missing or unsafe');
  }
  const names = fs.readdirSync(dir).sort();
  if (names.join(',') !== [...FILES].sort().join(',')) fail('native store inventory mismatch');
  let total = 0;
  const result = {};
  for (const filename of FILES) {
    const full = path.join(dir, filename);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_NATIVE) fail('unsafe native store file');
    total += stat.size;
    if (total > MAX_NATIVE) fail('native store exceeds fixture byte budget');
    const b = fs.readFileSync(full);
    // Keep the four complete SDK-native files; never rebuild a transcript.
    // A corrupt JSONL file is not a usable resume checkpoint.
    const lines = b.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try { JSON.parse(line); } catch { fail('invalid SDK JSONL file: ' + filename); }
    }
    if (filename === 'checkpoints.ndjson' && !lines.length) fail('missing native conversation checkpoint');
    result[filename] = b.toString('base64');
  }
  return result;
}
function metadataAad(meta) {
  // Authenticate all provenance and Harness attributes, not only ciphertext.
  return Buffer.from(JSON.stringify({schema_version:1,kind:'cursor-native-encrypted-snapshot',metadata:meta}));
}
function asPublicKey(pem) {
  try { return createPublicKey(pem); } catch { fail('missing or malformed fixture public key'); }
}
function asPrivateKey(pem) {
  try { return createPrivateKey(pem); } catch { fail('missing or malformed fixture private key'); }
}
export function sealCursorNativeStore({directory,metadata,publicKeyPem}) {
  const meta = valid(metadata);
  const files = strictFiles(directory);
  const plaintext = Buffer.from(JSON.stringify({files}));
  if (plaintext.length > MAX_NATIVE * 2) fail('oversized native archive');
  const key = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(metadataAad(meta));
    const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
    const wrapped = publicEncrypt({key:asPublicKey(publicKeyPem),padding:constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash:'sha256'},key);
    return {
      schema_version:1,kind:'cursor-native-encrypted-snapshot',metadata:meta,
      encryption:{algorithm:'aes-256-gcm+rsa-oaep-sha256',iv:iv.toString('base64'),
        tag:cipher.getAuthTag().toString('base64'),wrapped_key:wrapped.toString('base64')},
      ciphertext:ciphertext.toString('base64'),ciphertext_sha256:hash(ciphertext),
    };
  } finally { key.fill(0); plaintext.fill(0); }
}
export function openCursorNativeStore({record,privateKeyPem,expected,directory}) {
  if (record?.schema_version !== 1 || record.kind !== 'cursor-native-encrypted-snapshot' ||
      record.encryption?.algorithm !== 'aes-256-gcm+rsa-oaep-sha256') fail('unsupported ciphertext envelope');
  const meta = valid(record.metadata);
  for (const field of ['agent_id','source_sha','harness_digest','run_id','attempt','sdk_version']) {
    if (meta[field] !== expected?.[field]) fail('native checkpoint compatibility mismatch: ' + field);
  }
  const ciphertext = Buffer.from(record.ciphertext ?? '', 'base64');
  if (!ciphertext.length || ciphertext.length > MAX_NATIVE * 2 ||
      hash(ciphertext) !== record.ciphertext_sha256) fail('ciphertext hash/size mismatch');
  let key,plaintext;
  try {
    key = privateDecrypt({key:asPrivateKey(privateKeyPem),padding:constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash:'sha256'},Buffer.from(record.encryption.wrapped_key ?? '', 'base64'));
    if (key.length !== 32) fail('invalid recovered key');
    const decipher = createDecipheriv('aes-256-gcm',key,Buffer.from(record.encryption.iv ?? '', 'base64'));
    decipher.setAAD(metadataAad(meta));
    decipher.setAuthTag(Buffer.from(record.encryption.tag ?? '', 'base64'));
    plaintext = Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    const value = JSON.parse(plaintext.toString('utf8'));
    if (Object.keys(value).join(',') !== 'files' ||
        Object.keys(value.files ?? {}).sort().join(',') !== [...FILES].sort().join(',')) {
      fail('native file manifest mismatch');
    }
    if (fs.existsSync(directory)) fail('resume destination must be new');
    const parent = path.dirname(directory);
    if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory() ||
        fs.lstatSync(parent).isSymbolicLink()) fail('unsafe destination parent');
    const buffers = FILES.map(name => {
      if (typeof value.files[name] !== 'string' ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(value.files[name])) fail('bad native file encoding');
      const buf = Buffer.from(value.files[name],'base64');
      if (buf.length > MAX_NATIVE) fail('oversized native file');
      for (const line of buf.toString('utf8').split(/\r?\n/).filter(Boolean)) {
        try { JSON.parse(line); } catch { fail('invalid decrypted JSONL'); }
      }
      return buf;
    });
    if (!buffers[FILES.indexOf('checkpoints.ndjson')].length ||
        buffers.reduce((n,x)=>n+x.length,0) > MAX_NATIVE) fail('missing or oversized checkpoint');
    fs.mkdirSync(directory,{mode:0o700});
    for (let i=0;i<FILES.length;i++) fs.writeFileSync(path.join(directory,FILES[i]),buffers[i],
      {flag:'wx',mode:0o600});
    return {agent_id:meta.agent_id,source_sha:meta.source_sha};
  } catch (err) {
    if (err.message?.startsWith('Cursor native checkpoint:')) throw err;
    fail('native checkpoint authentication/decode failed');
  } finally {
    if (key) key.fill(0);
    if (plaintext) plaintext.fill(0);
  }
}
