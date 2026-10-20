#!/usr/bin/env node
// #2010 exact owner-only independent Ingest replay. Worker code, Issue
// comments, untrusted Action inputs and forked runs cannot mint receipts.
import assert from 'node:assert/strict';
import {resolveTrustedIngestSource} from './development-ingest.mjs';
const runId=39288961865;
const environment={
  GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BestNathan/nession',
  GITHUB_EVENT_NAME:'issue_comment',
  GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW:'Store / Agent Development Ingest',
  GITHUB_ACTOR:'BestNathan',GITHUB_SHA:'a'.repeat(40),
};
const event={action:'created',
  repository:{full_name:'BestNathan/nession'},
  issue:{number:1997},
  comment:{id:90909,user:{login:'BestNathan'},
    body:'/nession ingest issue=1997 worker_run=39288961865'}};
const good={environment,event};
assert.deepEqual(resolveTrustedIngestSource(good),{run_id:runId,source:null});
const resumeCommand='/nession ingest issue=1997 action=3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8 worker_run=39388961865';
const resumed={environment,event:{...event,comment:{...event.comment,body:resumeCommand}}};
assert.deepEqual(resolveTrustedIngestSource(resumed),{run_id:39388961865,source:null,continuation:true});
for(const command of [resumeCommand+' ',resumeCommand.replace('3f4abb','0f4abb'),
  resumeCommand.replace('39388961865','1'),resumeCommand.replace('issue=1997','issue=1998')])
  assert.throws(()=>resolveTrustedIngestSource({...resumed,event:{...resumed.event,
    comment:{...resumed.event.comment,body:command}}}));
const denied=[
  {environment:{...environment,GITHUB_ACTOR:'other'}},
  {environment:{...environment,GITHUB_REF:'refs/pull/5/merge'}},
  {environment:{...environment,GITHUB_WORKFLOW:'Agent / Development'}},
  {environment:{...environment,GITHUB_SHA:'invalid'}},
  {event:{...event,action:'edited'}},
  {event:{...event,repository:{full_name:'fork/nession'}}},
  {event:{...event,issue:{number:2010}}},
  {event:{...event,issue:{number:1997,pull_request:{url:'https://example.org'}}}},
  {event:{...event,comment:{...event.comment,user:{login:'attacker'}}}},
  {event:{...event,comment:{...event.comment,body:event.comment.body+' '}}},
  {event:{...event,comment:{...event.comment,body:'/nession ingest issue=1997 worker_run=123'}}},
];
for(const bad of denied)assert.throws(
  ()=>resolveTrustedIngestSource({...good,...bad}),/trusted|manual checkpoint/);
const workflowRun={...environment,GITHUB_EVENT_NAME:'workflow_run'};
const source={id:runId,run_attempt:1,
  head_sha:'e6e64eb84663f2bb935b9c0628d9ab787523186b',
  conclusion:'success'};
const workflowEvent={action:'completed',workflow_run:source};
assert.deepEqual(resolveTrustedIngestSource({environment:workflowRun,event:workflowEvent}),
  {run_id:runId,source});
assert.throws(()=>resolveTrustedIngestSource({environment:workflowRun,
  event:{...workflowEvent,action:'requested'}}),/completed successful/);
assert.throws(()=>resolveTrustedIngestSource({environment:workflowRun,
  event:{...workflowEvent,workflow_run:{...source,conclusion:'failure'}}}),/completed successful/);
console.log('Trusted Ingest replay: exact owner/main/source, fork, Issue, edited comment and event denial passed');
