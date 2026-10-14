import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const MAX_PATCH=256*1024,MAX_FILE=1024*1024,MAX_FILES=20;
const SHA40=/^[0-9a-f]{40}$/;
const FILE=/^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PROTECTED=['.git/','.github/','.claude/','.agents/','gates/',
  'automation/agents/','scripts/lib/agent/','scripts/issue-contract.mjs',
  'scripts/acceptance-','scripts/requirement-','scripts/agent-workflow-'];
function reject(reason){throw new Error('Agent patch preflight: '+reason);}
function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
export function validPublisherFile(value){
  if(typeof value!=='string'||value.length>180||!FILE.test(value)||
     value.startsWith('/')||value.includes('\\')||value.split('/').some(x=>x==='.'||x==='..'||x===''||x.startsWith('.'))||
     PROTECTED.some(prefix=>value===prefix.replace(/\/$/,'')||value.startsWith(prefix))) {
    reject('unsafe or protected file path');
  }
  return value;
}
export function inspectTextPatch(patch,allowedPaths){
  if(typeof patch!=='string'||Buffer.byteLength(patch)>MAX_PATCH||patch.length<30||
     !patch.endsWith('\n')||/[\r\0]/.test(patch))reject('invalid or oversized patch');
  if(!Array.isArray(allowedPaths)||allowedPaths.length<1||allowedPaths.length>MAX_FILES||
      new Set(allowedPaths).size!==allowedPaths.length)reject('invalid trusted path allowlist');
  const allowed=new Set(allowedPaths.map(validPublisherFile));
  const changed=[],entries=patch.split('\n');
  let current=null;
  for(const line of entries){
    if(line.startsWith('diff --git ')){
      const match=/^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
      if(!match||match[1]!==match[2])reject('unsupported rename, binary or unusual diff header');
      const file=validPublisherFile(match[1]);
      if(!allowed.has(file)||changed.includes(file))reject('patch path not uniquely authorized');
      changed.push(file);current={path:file,old:false,next:false,hunk:false};
    }else if(/^(?:new file mode|deleted file mode|old mode|new mode|rename |copy |similarity index|dissimilarity index|GIT binary patch|Binary files|Submodule )/.test(line)){
      reject('patch changes file type, mode, or contains binary/rename directives');
    }else if(line.startsWith('--- ')){
      if(!current||current.old||line!=='--- a/'+current.path)reject('patch old path is not trusted');
      current.old=true;
    }else if(line.startsWith('+++ ')){
      if(!current||current.next||line!=='+++ b/'+current.path)reject('patch new path is not trusted');
      current.next=true;
    }else if(line.startsWith('@@ ')){
      if(!current||!current.old||!current.next)reject('diff hunk has no validated file');
      current.hunk=true;
    }else if(line.startsWith('diff --git')||line.startsWith('Binary files')){
      reject('malformed or binary diff');
    }
  }
  if(changed.length===0||changed.length>MAX_FILES||!current?.old||!current.next||!current.hunk){
    reject('empty or incomplete text diff');
  }
  return changed;
}
function safeGitEnv(home){
  return {PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',
    GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'};
}
function runGit(cwd,args,env,input){
  try{return execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{
    cwd,env,encoding:'utf8',input,timeout:30000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe'],
  }).trimEnd();}
  catch{reject('Git validation or application failed');}
}
function safeRegular(root,file){
  const full=path.join(root,file);let current=root;
  for(const segment of file.split('/').slice(0,-1)){
    current=path.join(current,segment);
    if(!fs.existsSync(current)||!fs.lstatSync(current).isDirectory()||
       fs.lstatSync(current).isSymbolicLink())reject('unsafe intermediate directory');
  }
  if(!fs.existsSync(full)||!fs.lstatSync(full).isFile()||fs.lstatSync(full).isSymbolicLink()||
      fs.statSync(full).size>MAX_FILE)reject('missing, oversized or nonregular authorized file');
  return fs.readFileSync(full);
}
// No publication or untrusted code execution. Git hooks, ambient credentials,
// and source checkout mutation are excluded. Caller still owns authorization.
export function preflightAgentPatch({checkout,source_sha,patch,allowed_paths}){
  if(typeof checkout!=='string'||!path.isAbsolute(checkout)||!SHA40.test(source_sha??'')){
    reject('missing exact trusted checkout/source SHA');
  }
  const changed=inspectTextPatch(patch,allowed_paths);
  const source=path.resolve(checkout),root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-patch-preflight-'));
  const env=safeGitEnv(root);
  try{
    if(runGit(source,['rev-parse','--show-toplevel'],env)!==source||
       runGit(source,['rev-parse','HEAD'],env)!==source_sha||
       runGit(source,['status','--porcelain=v1','--untracked-files=no'],env)!==''){
      reject('source checkout is dirty or has wrong pinned SHA');
    }
    for(const file of changed){
      safeRegular(source,file);
      if(!runGit(source,['ls-files','-s','--',file],env).startsWith('100644 ')){
        reject('only tracked regular non-executable files may change');
      }
    }
    const clone=path.join(root,'repo');
    const template=path.join(root,'empty-template');fs.mkdirSync(template);
    runGit(root,['clone','--quiet','--shared','--no-checkout','--template='+template,source,clone],env);
    runGit(clone,['checkout','--quiet','--detach',source_sha],env);
    runGit(clone,['remote','remove','origin'],env);
    if(runGit(clone,['rev-parse','HEAD'],env)!==source_sha)reject('scratch clone SHA drift');
    runGit(clone,['apply','--check','--index','--whitespace=error','-'],env,patch);
    runGit(clone,['apply','--index','--whitespace=error','-'],env,patch);
    runGit(clone,['diff','--cached','--check'],env);
    const changedGit=runGit(clone,['diff','--cached','--name-status','--no-renames'],env)
      .split('\n').filter(Boolean).map(line=>{
        const m=/^([A-Z])\t([^\t]+)$/.exec(line);
        if(!m||m[1]!=='M')reject('patch created/renamed/deleted tracked content');
        return validPublisherFile(m[2]);
      });
    if(changedGit.length!==changed.length||new Set(changedGit).size!==changed.length||
       changed.some(x=>!changedGit.includes(x)))reject('applied changes do not match proposed paths');
    const files=changed.sort().map(file=>{
      const mode=runGit(clone,['ls-files','-s','--',file],env);
      if(!mode.startsWith('100644 '))reject('post-apply file-mode drift');
      const before=safeRegular(source,file),after=safeRegular(clone,file);
      if(before.equals(after))reject('no-op file edit');
      return {path:file,old_sha256:hash(before),new_sha256:hash(after),
        old_bytes:before.length,new_bytes:after.length};
    });
    return {schema_version:1,source_sha,patch_sha256:hash(Buffer.from(patch)),
      files,scope:'preflight_only'};
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
