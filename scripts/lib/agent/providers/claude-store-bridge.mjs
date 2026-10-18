// Bridge Claude's PUBLIC-KEY encrypted native Session transport into the
// pre-existing trusted agent-store AES v1 + Git remote CAS protocol (#1664).
// Only a trusted ingester may call this with storeKey; the Provider/Worker has
// the RSA PUBLIC key only and never receives a Store secret or Git writer token.
import {createHash} from 'node:crypto';
import {sealCheckpoint,unsealCheckpoint} from '../store/checkpoint.mjs';
import {openClaudeNativeSession} from './claude-native-store.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
const SHA=/^[a-f0-9]{40}$/;
function fail(message){throw Error('Claude Store bridge: '+message);}
function metaOf(record){
  const m=record?.metadata;
  if(record?.schema_version!==1||record.kind!=='claude-native-encrypted-snapshot'||
    record.encryption?.algorithm!=='aes-256-gcm+rsa-oaep-sha256'||
    !UUID.test(m?.session_id??'')||!SHA.test(m?.source_sha??'')||
    !HEX.test(m?.harness_digest??'')||
    !HEX.test(record.ciphertext_sha256??'')||
    typeof record.ciphertext!=='string'||record.ciphertext.length>24*1024*1024)
    fail('untrusted native ciphertext envelope');
  const raw=Buffer.from(record.ciphertext,'base64');
  if(!raw.length||raw.length>16*1024*1024||
      createHash('sha256').update(raw).digest('hex')!==record.ciphertext_sha256)
    fail('native ciphertext checksum invalid');
  return m;
}
// The Store key is isolated from the model. This wraps an already encrypted
// Claude Session; even a pre-commit diagnostic cannot contain native plaintext.
export function wrapClaudeNativeCheckpoint({identity,version,nativeEnvelope,storeKey}){
  const meta=metaOf(nativeEnvelope);
  const bytes=Buffer.from(JSON.stringify(nativeEnvelope));
  try{
    if(bytes.length>15*1024*1024)fail('double-encrypted Store envelope byte limit');
    return sealCheckpoint(identity,version,bytes,storeKey,{
      provider:'claude-code',session_id:meta.session_id,
      source_sha:meta.source_sha,harness_digest:meta.harness_digest,
    });
  }finally{bytes.fill(0);}
}
// Trusted restore authenticates outer agent-store identity/Harness then restores
// only the exact UUID's RSA envelope into an isolated native CLAUDE_CONFIG_DIR.
// The private RSA key remains outside model execution after this step.
export function unwrapClaudeNativeCheckpoint({identity,record,storeKey,
  privateKeyPem,expectedMetadata,configDir}) {
  const plaintext=unsealCheckpoint(identity,record,storeKey);
  try{
    let sealed;
    try{sealed=JSON.parse(plaintext.toString('utf8'));}
    catch{fail('corrupt stored native ciphertext JSON');}
    const meta=metaOf(sealed);
    const outer=record.metadata;
    if(outer?.provider!=='claude-code'||outer.session_id!==meta.session_id||
        outer.source_sha!==meta.source_sha||outer.harness_digest!==meta.harness_digest)
      fail('outer and native checkpoint metadata mismatch');
    return openClaudeNativeSession({record:sealed,privateKeyPem,
      expected:expectedMetadata,configDir});
  }finally{plaintext.fill(0);}
}
