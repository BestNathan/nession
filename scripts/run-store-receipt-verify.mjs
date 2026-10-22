#!/usr/bin/env node
// #1690: read-only consumer of exact Git-tree post-commit receipts.
// A valid receipt establishes byte binding only, NOT independent signing,
// GitHub writer authorization, historical truth, or artifact permanence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {classifyRunStorePath} from './run-store-integrity.mjs';

const HEX40=/^[0-9a-f]{40}$/;
const HEX64=/^[0-9a-f]{64}$/;
const POSITIVE=/^[1-9][0-9]*$/;
const STORES=new Set(['acceptance-results','task-results','metrics','agent-store']);
const SAFE_REF=/^refs\/heads\/[a-z0-9-]+$/;
const SHA256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const reject=reason=>{throw new Error('run-store-receipt-verify: '+reason);};
function git(root,args,{buffer=false,quiet=false}={}){
  try{
    return execFileSync('git',['-C',root,...args],{
      encoding:buffer?null:'utf8',timeout:30000,maxBuffer:12*1024*1024,
      stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},
    });
  }catch(e){
    if(quiet)return null;
    reject('Git '+args[0]+' unavailable or unsafe ('+(e.status??'unknown')+')');
  }
}
function sha(value,label){if(typeof value!=='string'||!HEX40.test(value))reject('invalid '+label);return value;}
function str(value,label,pattern,max=240){
  if(typeof value!=='string'||value.length===0||value.length>max||!pattern.test(value))
    reject('invalid '+label);
  return value;
}
function jsonObject(v,label){if(!v||typeof v!=='object'||Array.isArray(v))reject('invalid '+label);return v;}
function treeBlob(root,commit,file){
  // -z keeps adversarial filenames unambiguous. Path policy rejects unsafe paths.
  const bytes=git(root,['ls-tree','-z',commit,'--',file],{buffer:true});
  if(bytes.length===0)reject('record missing at persisted commit: '+file);
  const marker=bytes.indexOf(0);
  if(marker!==bytes.length-1)reject('ambiguous Git tree entry: '+file);
  const entry=bytes.subarray(0,marker).toString('utf8');
  const m=/^(100644) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
  if(!m||m[3]!==file)reject('non-regular or mismatched Git tree entry: '+file);
  return git(root,['cat-file','blob',m[2]],{buffer:true});
}
/**
 * Verify a finite-retention publisher receipt against immutable Git object IDs.
 * Caller must independently authenticate the receipt's Actions artifact/run and
 * provide a trusted branch checkout; checking this schema alone is insufficient.
 */
export function verifyRunStoreReceipt(raw,root,{expectedStore=null,requireAncestor=true}={}){
  const receipt=jsonObject(raw,'receipt');
  if(receipt.schema_version!==1||receipt.kind!=='run_store_post_commit_receipt'||
     receipt.trust_level!=='trusted_workflow_artifact_not_independent_anchor')
    reject('unknown receipt version/kind/trust level');
  const store=str(receipt.store,'store',/^[a-z-]+$/);
  if(!STORES.has(store)||expectedStore&&store!==expectedStore)
    reject('unexpected run store');
  if(receipt.ref!=='refs/heads/'+store||!SAFE_REF.test(receipt.ref))
    reject('unexpected ref');
  if(!['published','idempotent-replay'].includes(receipt.status))
    reject('invalid publication status');
  const commit=sha(receipt.commit_sha,'persisted commit SHA');
  const ingester=jsonObject(receipt.ingester,'ingester');
  if(ingester.repository!=='BestNathan/nession')reject('unexpected ingester repository');
  str(ingester.run_id,'ingester run ID',POSITIVE);
  str(ingester.attempt,'ingester attempt',POSITIVE);
  sha(ingester.tool_sha,'trusted ingester tooling SHA');
  str(ingester.workflow_ref,'ingester workflow ref',/^BestNathan\/nession\/\.github\/workflows\/[a-z0-9-]+\.yml@refs\/heads\/main$/,250);
  const source=jsonObject(receipt.source,'source');
  str(source.repository,'source repository',/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  str(source.run_id,'source run ID',POSITIVE);
  str(source.attempt,'source attempt',POSITIVE);
  sha(source.target_sha,'source target SHA');
  str(source.event,'source event',/^(?:push|pull_request|pull_request_target|workflow_dispatch|workflow_run|issues|schedule|repository_dispatch)$/);
  if(source.workflow_id!==''&&!POSITIVE.test(source.workflow_id??''))
    reject('invalid source workflow ID');
  if(source.workflow_path!==''&&
     !/^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(source.workflow_path??''))
    reject('invalid source workflow path');
  if(!Array.isArray(receipt.records)||!receipt.records.length||receipt.records.length>1024)
    reject('missing/excessive record hashes');
  if(git(root,['cat-file','-t',commit]).trim()!=='commit')reject('target not a commit');
  const parents=git(root,['show','-s','--format=%P',commit]).trim().split(' ').filter(Boolean);
  if(parents.length!==1||!HEX40.test(parents[0]))
    reject('published Run Store commit must have exactly one parent');
  if(requireAncestor&&git(root,['merge-base','--is-ancestor',commit,'HEAD'],{quiet:true})===null)
    reject('receipt commit not in observed store ancestry (rewritten/replaced ref)');
  let changed=0;const seen=new Set(),verified=[];
  for(const item of receipt.records){
    jsonObject(item,'record');
    const file=str(item.path,'record path',/^[^\x00-\x1f\x7f\\]+$/,800);
    if(seen.has(file))reject('duplicate record hash key');
    seen.add(file);
    if(classifyRunStorePath(store,file)==='unclassified')
      reject('unexpected store record path: '+file);
    if(!HEX64.test(item.sha256??''))reject('invalid record SHA-256: '+file);
    const bytes=treeBlob(root,commit,file);
    if(SHA256(bytes)!==item.sha256)
      reject('record bytes differ from reported hash: '+file);
    const old=git(root,['ls-tree','-z',parents[0],'--',file],{buffer:true});
    if(!old.equals(git(root,['ls-tree','-z',commit,'--',file],{buffer:true})))changed++;
    verified.push({path:file,sha256:item.sha256,bytes:bytes.length});
  }
  if(receipt.status==='published'&&!changed)
    reject('published receipt has no changed record at its claimed commit');
  return {
    schema_version:1,kind:'run_store_receipt_readback',store,
    commit_sha:commit,ingester_run_id:ingester.run_id,
    source_run_id:source.run_id,checked_records:verified.length,
    changed_records:changed,claim:'Git byte binding only; requires separately authenticated artifact and anchor',
  };
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    const [file,root,store]=process.argv.slice(2);
    if(!file||!path.isAbsolute(file)||!root||!path.isAbsolute(root)||!store)
      reject('usage: ABS_RECEIPT_JSON ABS_STORE_CHECKOUT STORE');
    const result=verifyRunStoreReceipt(JSON.parse(fs.readFileSync(file,'utf8')),root,{expectedStore:store});
    console.log(JSON.stringify(result));
  }catch(e){console.error('::error::'+String(e.message));process.exitCode=1;}
}
