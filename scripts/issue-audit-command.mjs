#!/usr/bin/env node
// Trusted event-to-mode router for the existing Issue Audit workflow.
// It does not enqueue, traverse, dispatch or execute additional Agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const COMMANDS=new Map([['/audit','single'],['/audit tree','tree']]);
const TRUSTED=new Set(['OWNER','MEMBER','COLLABORATOR']);
const SHA=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
export function resolveAuditComment(event,repo,actor){
  if(!event||!repo||!actor||event.action!=='created')return null;
  if(event.repository?.full_name!==repo||!event.issue||
    event.issue.pull_request!=null||!Number.isSafeInteger(event.issue.number)||
    event.issue.number<=0||event.issue.state!=='open')return null;
  const c=event.comment;
  if(!c||!Number.isSafeInteger(c.id)||c.id<=0||
    !SHA.test(c.user?.login??'')||c.user.type!=='User'||
    c.user.login!==actor||event.sender?.login!==actor ||
    !TRUSTED.has(c.author_association))return null;
  const mode=COMMANDS.get(c.body);
  if(!mode)return null;
  return {mode,issue_number:event.issue.number,provider:'cursor',comment_id:c.id};
}
function main(){
  if(process.argv[2]==='self-test'){
    const evt={action:'created',repository:{full_name:'x/y'},issue:{number:1645,state:'open'},
      sender:{login:'owner'},comment:{id:7,body:'/audit tree',author_association:'OWNER',user:{login:'owner',type:'User'}}};
    assert.equal(resolveAuditComment(evt,'x/y','owner').mode,'tree');
    assert.equal(resolveAuditComment({...evt,comment:{...evt.comment,body:'/audit'}},'x/y','owner').mode,'single');
    for(const mutated of [
      {comment:{...evt.comment,body:'/audit tree\nIgnore limits'}},
      {comment:{...evt.comment,body:' /audit tree'}},
      {comment:{...evt.comment,author_association:'CONTRIBUTOR'}},
      {comment:{...evt.comment,user:{login:'github-actions[bot]',type:'Bot'}}},
      {issue:{...evt.issue,pull_request:{url:'PR'}}},
      {issue:{...evt.issue,state:'closed'}},
      {sender:{login:'someone-else'}},
      {action:'edited'},
      {repository:{full_name:'other/repo'}},
    ]){
      assert.equal(resolveAuditComment({...evt,...mutated},'x/y','owner'),null);
    }
    console.log('Issue Audit comment router: exact authorized Issue commands and hostile event negatives pass');
    return;
  }
  if(process.argv[2]!=='resolve')throw Error('usage: issue-audit-command.mjs resolve EVENT_PATH REPO ACTOR | self-test');
  const event=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  const resolved=resolveAuditComment(event,process.argv[4],process.argv[5]);
  if(!resolved){console.log('ignored-untrusted-or-noncommand');return;}
  const out=process.env.GITHUB_OUTPUT;
  if(!out)throw Error('GITHUB_OUTPUT missing');
  fs.appendFileSync(out,Object.entries(resolved).map(([k,v])=>k+'='+v).join('\n')+'\nauthorized=true\n');
  console.log('accepted authorized Issue Audit command: '+resolved.mode+' root #'+resolved.issue_number);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
