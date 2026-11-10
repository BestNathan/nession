// Optional build-time reconstruction of canonical schemas from official tags.
// No hand-authored field versions, no parsing Rust source, no main-branch
// schema substituted for a historical release. A failure is an UNKNOWN.
// A tag must resolve to the exact commit verified by the GitHub Releases API.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const exec=promisify(execFile);
const SHA=/^[a-f0-9]{40}$/;
const TAG=/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DRAFT='https://json-schema.org/draft/2020-12/schema';
const MAX_BYTES=8_000_000;
const MAX_GENERATE_MS=180_000;
const schemaOk=s=>s?.$schema===DRAFT&&s.protocols&&
  typeof s.protocols==='object'&&!Array.isArray(s.protocols)&&
  s.$defs&&typeof s.$defs==='object'&&!Array.isArray(s.$defs);
async function shell(program,args,opts={}){
  const {stdout}=await exec(program,args,{timeout:15000,maxBuffer:MAX_BYTES,
    ...opts});
  return stdout.trim();
}
async function readCache(file,tag,sha){
  try{
    const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)return null;
    const cached=JSON.parse(await readFile(file,'utf8'));
    return cached?.source?.tag===tag&&cached?.source?.sha===sha&&
      schemaOk(cached.schema)?cached.schema:null;
  }catch{return null;}
}
function codegenEnvironment(cacheDir,checkoutDir){
  // A historical Cargo build runs with a new HOME/CARGO_HOME and without the
  // GitHub Actions token or host credentials. Do not inherit process.env.
  return {
    PATH:process.env.PATH||'/usr/bin:/bin',
    HOME:join(checkoutDir,'isolated-home'),
    CARGO_HOME:join(cacheDir,'cargo-home'),
    RUSTUP_HOME:process.env.RUSTUP_HOME||
      join(process.env.HOME||'/home/runner','.rustup'),
    CARGO_TARGET_DIR:join(cacheDir,'cargo-target'),
    CARGO_TERM_COLOR:'never',
    CARGO_NET_GIT_FETCH_WITH_CLI:'false',
    GIT_TERMINAL_PROMPT:'0',
    CI:'true',
  };
}
export async function taggedProtocolSchema({tag,sha,repoRoot,cacheDir,command=shell}){
  if(!TAG.test(tag||'')||!SHA.test(sha||'')||!repoRoot)return null;
  const root=resolve(repoRoot);
  const cache=resolve(cacheDir||join(tmpdir(),'nession-pages-protocol-cache'));
  const cacheFile=join(cache,'schema-'+sha+'.json');
  const cached=await readCache(cacheFile,tag,sha);
  if(cached)return cached;
  let worktree=null,checkout=null;
  try{
    // A shallow Pages checkout need not contain Release tags. Fetch only the
    // requested public tag; compare the fetched target with the API-pinned SHA.
    let found=null;
    try{
      found=await command('git',['-C',root,'rev-parse','--verify',
        'refs/tags/'+tag+'^{commit}']);
    }catch{}
    if(!found){
      await command('git',['-C',root,'fetch','--quiet','--no-tags',
        '--depth=1','origin','refs/tags/'+tag],{timeout:30000});
      found=await command('git',['-C',root,'rev-parse','--verify',
        'FETCH_HEAD^{commit}']);
    }
    if(found!==sha)throw Error('tag commit does not match GitHub Release SHA');

    // Pre-generator releases are *unknown*, not assumed to lack any field.
    await command('git',['-C',root,'cat-file','-e',
      sha+':crates/nession-protocol-codegen/Cargo.toml']);
    await command('git',['-C',root,'cat-file','-e',
      sha+':crates/nession-protocol-codegen/src/schema.rs']);

    worktree=await mkdtemp(join(tmpdir(),'nession-tag-schema-'));
    checkout=join(worktree,'checkout');
    await command('git',['-C',root,'worktree','add','--detach',checkout,sha],
      {timeout:30000});
    const cargo=await readFile(join(checkout,'Cargo.toml'),'utf8');
    if(!cargo.includes('"crates/nession-protocol-codegen"'))
      throw Error('historical codegen not in Cargo workspace');
    await mkdir(join(worktree,'isolated-home'),{recursive:true});
    await mkdir(join(cache,'cargo-home'),{recursive:true});
    const raw=await command('cargo',
      ['run','--locked','--quiet','-p','nession-protocol-codegen','--','--schema'],
      {cwd:checkout,env:codegenEnvironment(cache,worktree),
        timeout:MAX_GENERATE_MS,maxBuffer:MAX_BYTES});
    if(Buffer.byteLength(raw)>MAX_BYTES)throw Error('historical schema too large');
    const schema=JSON.parse(raw);
    if(!schemaOk(schema))throw Error('invalid tagged Rust codegen schema');
    await mkdir(cache,{recursive:true});
    const tmp=join(worktree,'schema-cache.json');
    await writeFile(tmp,JSON.stringify({source:{tag,sha},schema})+'\n',{mode:0o600});
    await rename(tmp,cacheFile);
    return schema;
  }catch(error){
    console.warn('Historical Rust Protocol schema unavailable:',tag,error.message);
    return null;
  }finally{
    if(checkout){
      try{await command('git',['-C',root,'worktree','remove','--force',checkout],
        {timeout:30000});}
      catch(error){console.warn('Historical worktree cleanup failed:',error.message);}
    }
    if(worktree)await rm(worktree,{recursive:true,force:true});
  }
}
