// #1664 Claude Code native session checkpoint (never a reconstructed transcript).
// Transport is encrypted before ANY public-Repository Actions Artifact is created.
import fs from 'node:fs';
import path from 'node:path';
import {
  createHash,createCipheriv,createDecipheriv,createPublicKey,createPrivateKey,
  publicEncrypt,privateDecrypt,randomBytes,constants,
} from 'node:crypto';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX40=/^[a-f0-9]{40}$/, HEX64=/^[a-f0-9]{64}$/;
const PROJECT=/^[A-Za-z0-9._-]{1,240}$/;
const MAX_TOTAL=16*1024*1024, MAX_FILES=64;
const hash=value=>createHash('sha256').update(value).digest('hex');
function fail(text){throw new Error('Claude native checkpoint: '+text);}
function directory(value) {
  if(!fs.existsSync(value)||!fs.lstatSync(value).isDirectory()||fs.lstatSync(value).isSymbolicLink())
    fail('unsafe or missing directory');
}
function metadata(value) {
  if(!value||!UUID.test(value.session_id??'')||!HEX40.test(value.source_sha??'')||
    !HEX64.test(value.harness_digest??'')||!PROJECT.test(value.project_key??'')||
    !HEX64.test(value.cwd_sha256??'')||
    !Number.isSafeInteger(value.run_id)||value.run_id<1||
    !Number.isSafeInteger(value.attempt)||value.attempt<1||
    typeof value.cli_version!=='string'||!/^[A-Za-z0-9.+-]{1,80}$/.test(value.cli_version))
    fail('invalid native Session provenance/compatibility metadata');
  return value;
}
const aad=meta=>Buffer.from(JSON.stringify({schema_version:1,
  kind:'claude-native-encrypted-snapshot',metadata:meta}));
function manifest(configDir,sessionId){
  directory(configDir);
  const projects=path.join(configDir,'projects');
  directory(projects);
  const matches=[];
  for(const name of fs.readdirSync(projects)){
    if(!PROJECT.test(name))fail('unsafe project key');
    const folder=path.join(projects,name);
    directory(folder);
    const transcript=path.join(folder,sessionId+'.jsonl');
    if(fs.existsSync(transcript))matches.push({name,folder,transcript});
  }
  if(matches.length!==1)fail('expected exactly one native project transcript for Session');
  const found=matches[0], files=[];
  const add=(absolute,relative)=>{
    const stat=fs.lstatSync(absolute);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MAX_TOTAL)
      fail('unsafe native session file');
    if(!/^[a-zA-Z0-9._/-]+$/.test(relative)||relative.split('/').includes('..')||
      relative.split('/').some(x=>!x||x==='.')||files.length>=MAX_FILES)
      fail('unsafe or excessive session member');
    if(!relative.endsWith('.jsonl'))fail('unsupported native session dependency');
    const raw=fs.readFileSync(absolute);
    let matched=false;
    for(const line of raw.toString('utf8').split(/\r?\n/).filter(Boolean)){
      let record;try{record=JSON.parse(line);}catch{fail('invalid native JSONL');}
      if(record&&typeof record==='object'&&record.sessionId===sessionId)matched=true;
    }
    if(relative===sessionId+'.jsonl'&&!matched)
      fail('main transcript does not contain expected Session ID');
    files.push({path:relative,base64:raw.toString('base64')});
  };
  add(found.transcript,sessionId+'.jsonl');
  const auxiliary=path.join(found.folder,sessionId);
  if(fs.existsSync(auxiliary)){
    directory(auxiliary);
    const scan=(folder,prefix,depth)=>{
      if(depth>4)fail('native session tree nesting limit');
      for(const name of fs.readdirSync(folder).sort()){
        if(!/^[a-zA-Z0-9._-]{1,150}$/.test(name)||name==='.'||name==='..')
          fail('unsafe session filename');
        const absolute=path.join(folder,name),stat=fs.lstatSync(absolute);
        if(stat.isSymbolicLink())fail('symlinked session dependency');
        if(stat.isDirectory())scan(absolute,prefix+name+'/',depth+1);
        else add(absolute,prefix+name);
      }
    };
    scan(auxiliary,sessionId+'/',0);
  }
  if(files.reduce((n,x)=>n+Buffer.byteLength(x.base64,'base64'),0)>MAX_TOTAL)
    fail('native session exceeds byte budget');
  return {project_key:found.name,files};
}
export function sealClaudeNativeSession({configDir,metadata:rawMeta,publicKeyPem}) {
  const meta=metadata(rawMeta);
  const snapshot=manifest(configDir,meta.session_id);
  if(snapshot.project_key!==meta.project_key)fail('native project directory changed');
  const plain=Buffer.from(JSON.stringify({files:snapshot.files}));
  if(plain.length>MAX_TOTAL*2)fail('encoded native session too large');
  const key=randomBytes(32),iv=randomBytes(12);
  try{
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(aad(meta));
    const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
    let pub;try{pub=createPublicKey(publicKeyPem);}catch{fail('invalid public encryption key');}
    if(pub.asymmetricKeyType!=='rsa')fail('RSA public key required');
    const wrapped=publicEncrypt({key:pub,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
    return {schema_version:1,kind:'claude-native-encrypted-snapshot',metadata:meta,
      encryption:{algorithm:'aes-256-gcm+rsa-oaep-sha256',iv:iv.toString('base64'),
        tag:cipher.getAuthTag().toString('base64'),wrapped_key:wrapped.toString('base64')},
      ciphertext:encrypted.toString('base64'),ciphertext_sha256:hash(encrypted)};
  }finally{key.fill(0);plain.fill(0);}
}
export function openClaudeNativeSession({record,privateKeyPem,expected,configDir}){
  if(record?.schema_version!==1||record.kind!=='claude-native-encrypted-snapshot'||
    record.encryption?.algorithm!=='aes-256-gcm+rsa-oaep-sha256')
    fail('unsupported native encrypted envelope');
  const meta=metadata(record.metadata);
  for(const field of ['session_id','source_sha','harness_digest','project_key',
      'cwd_sha256','run_id','attempt','cli_version']) {
    if(meta[field]!==expected?.[field])fail('incompatible native Session metadata: '+field);
  }
  const cipherBytes=Buffer.from(record.ciphertext??'','base64');
  if(!cipherBytes.length||cipherBytes.length>MAX_TOTAL*2||
      hash(cipherBytes)!==record.ciphertext_sha256)fail('ciphertext integrity mismatch');
  let key,plain;
  try{
    let priv;try{priv=createPrivateKey(privateKeyPem);}catch{fail('invalid private decrypting key');}
    key=privateDecrypt({key:priv,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},
      Buffer.from(record.encryption.wrapped_key??'','base64'));
    if(key.length!==32)fail('invalid content decryption key');
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(record.encryption.iv??'','base64'));
    decipher.setAAD(aad(meta));
    decipher.setAuthTag(Buffer.from(record.encryption.tag??'','base64'));
    plain=Buffer.concat([decipher.update(cipherBytes),decipher.final()]);
    const data=JSON.parse(plain.toString('utf8'));
    if(!data||Object.keys(data).join(',')!=='files'||!Array.isArray(data.files)||
      data.files.length<1||data.files.length>MAX_FILES||
      data.files[0].path!==meta.session_id+'.jsonl')
      fail('bad native file manifest');
    if(fs.existsSync(configDir))fail('restore config destination must be new');
    const parent=path.dirname(configDir);
    directory(parent);
    const payload=[],names=new Set();
    for(const file of data.files){
      if(!file||typeof file.path!=='string'||typeof file.base64!=='string'||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)||
        !file.path.endsWith('.jsonl')||names.has(file.path))
        fail('unsafe native file');
      const segments=file.path.split('/');
      if(segments.some(s=>!s||s==='.'||s==='..'||!/^[A-Za-z0-9._-]{1,150}$/.test(s))||
        (segments.length>1&&segments[0]!==meta.session_id)||
        (segments.length===1&&file.path!==meta.session_id+'.jsonl'))
        fail('out-of-scope native file');
      names.add(file.path);
      const buf=Buffer.from(file.base64,'base64');
      if(!buf.length||buf.length>MAX_TOTAL)fail('native file size violation');
      for(const line of buf.toString('utf8').split(/\r?\n/).filter(Boolean)){
        try{JSON.parse(line);}catch{fail('corrupt decrypted native JSONL');}
      }
      payload.push({name:file.path,buf});
    }
    if(payload.reduce((n,x)=>n+x.buf.length,0)>MAX_TOTAL)fail('native content budget exceeded');
    fs.mkdirSync(configDir,{mode:0o700});
    const project=path.join(configDir,'projects',meta.project_key);
    fs.mkdirSync(project,{recursive:true,mode:0o700});
    for(const file of payload){
      const absolute=path.join(project,file.name);
      fs.mkdirSync(path.dirname(absolute),{recursive:true,mode:0o700});
      fs.writeFileSync(absolute,file.buf,{flag:'wx',mode:0o600});
    }
    return {session_id:meta.session_id,project_key:meta.project_key};
  }catch(error){
    if(error.message?.startsWith('Claude native checkpoint:'))throw error;
    fail('native Session decrypt/parse authentication failed');
  }finally{if(key)key.fill(0);if(plain)plain.fill(0);}
}
export function discoverClaudeNativeProject(configDir,sessionId){
  if(!UUID.test(sessionId??''))fail('invalid native Session ID');
  return manifest(configDir,sessionId).project_key;
}
