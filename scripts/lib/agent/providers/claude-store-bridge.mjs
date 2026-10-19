// Bridge Claude's PUBLIC-KEY encrypted native Session transport into the
// pre-existing trusted agent-store AES v1 + Git remote CAS protocol (#1664).
// Only a trusted ingester may call this with storeKey; the Provider/Worker has
// the RSA PUBLIC key only and never receives a Store secret or Git writer token.
import {createHash} from 'node:crypto';
import {sealCheckpoint,unsealCheckpoint} from '../store/checkpoint.mjs';
import {openClaudeNativeSession} from './claude-native-store.mjs';
import {publishEncryptedAgentCheckpoint,fetchEncryptedAgentCheckpoint} from '../store/remote.mjs';

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

// Must be called from an authenticated trusted-main Ingest, NEVER the model
// executor. The remote publisher enforces source Registry, immutable records,
// sequence head and no-force CAS. This function does not grant GitHub auth.
export function publishClaudeNativeCheckpoint({
  remote,source,nativeEnvelope,registry,storeKey,expectedVersion,
}) {
  if(source?.role!=='developer'&&source?.role!=='reviewer'&&source?.role!=='acceptor')
    fail('unsupported Claude Agent checkpoint role');
  const identity={role:source.role,agent_id:source.agent_id,issue:source.issue};
  const sealed=wrapClaudeNativeCheckpoint({identity,version:expectedVersion+1,
    nativeEnvelope,storeKey});
  return publishEncryptedAgentCheckpoint({
    remote,source,sealed,registry,key:storeKey,expectedVersion,
  });
}

export function restoreClaudeNativeCheckpoint({
  remote,identity,storeKey,privateKeyPem,expectedMetadata,configDir,
}) {
  if(!expectedMetadata||!expectedMetadata.harness_digest||!expectedMetadata.source_sha)
    fail('expected exact Session and Harness identity required');
  const remoteValue=fetchEncryptedAgentCheckpoint({
    remote,identity,key:storeKey,expected:{
      provider:'claude-code',
      source_sha:expectedMetadata.source_sha,
      harness_digest:expectedMetadata.harness_digest,
    },
  });
  const bytes=remoteValue.native_bytes;
  try{
    let envelope;
    try{envelope=JSON.parse(bytes.toString('utf8'));}
    catch{fail('corrupt native ciphertext from trusted remote Store');}
    const metadata=metaOf(envelope);
    if(metadata.session_id!==expectedMetadata.session_id)
      fail('remote Store has a different native Session UUID');
    const restored=openClaudeNativeSession({record:envelope,privateKeyPem,
      expected:expectedMetadata,configDir});
    return {...restored,head:remoteValue.head,commit_sha:remoteValue.commit_sha};
  }finally{bytes.fill(0);}
}
