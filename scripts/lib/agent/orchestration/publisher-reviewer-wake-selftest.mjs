#!/usr/bin/env node
// #3550 deterministic bot Publisher source/job/Store negative contracts.
import assert from 'node:assert/strict';
import {assertPublisherReviewerWake} from './publisher-reviewer-wake.mjs';
const sha='a'.repeat(40),head='b'.repeat(40), action='c'.repeat(64);
const environment={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'BestNathan/nession',
  GITHUB_WORKFLOW:'Agent / Controller Dispatch',
  GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
  GITHUB_ACTOR:'github-actions[bot]',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:sha};
const event={repository:{full_name:'BestNathan/nession'},ref:'refs/heads/main',
  inputs:{issue_number:'3433',action_id:action,
    source_publisher_run_id:'43607502468',recovery_run_id:'0'}};
const sourceRun={id:43607502468,run_attempt:1,
  path:'.github/workflows/store-qwen-publisher.yml',
  name:'Store / Qwen Publisher',event:'workflow_dispatch',
  actor:{login:'github-actions[bot]'},head_branch:'main',
  head_sha:sha,repository:{full_name:'BestNathan/nession'},
  head_repository:{full_name:'BestNathan/nession'},status:'in_progress',
  conclusion:null};
const jobs={total_count:2,jobs:[
  {name:'detect',run_id:sourceRun.id,status:'completed',conclusion:'success'},
  {name:'publish',run_id:sourceRun.id,status:'completed',conclusion:'success',
    steps:[{name:'Authenticate original Qwen and publish/reconcile one real PR',
      status:'completed',conclusion:'success'}]},
]};
const storeSource={issue:3433,reviewer_action_id:action,
  publisher_run_id:sourceRun.id,review_sha:head,base_sha:sha,
  branch:'refs/heads/agent/3433/qwen-0945d3cc4bfacf3a'};
const valid={environment,event,sourceRun,jobs,storeSource};
assert.equal(assertPublisherReviewerWake(valid).action_id,action);
assert.equal(assertPublisherReviewerWake({...valid,sourceRun:{...sourceRun,
  status:'completed',conclusion:'success'}}).issue,3433);
const reject=patch=>assert.throws(()=>assertPublisherReviewerWake({...valid,...patch}),
  /trusted Publisher Reviewer wake:/);
for(const patch of [
  {environment:{...environment,GITHUB_ACTOR:'BestNathan'}},
  {environment:{...environment,GITHUB_RUN_ATTEMPT:'2'}},
  {environment:{...environment,GITHUB_REF:'refs/heads/staging'}},
  {environment:{...environment,GITHUB_REPOSITORY:'fork/nession'}},
  {event:{...event,ref:'refs/heads/staging'}},
  {event:{...event,inputs:{...event.inputs,unexpected:'yes'}}},
  {event:{...event,inputs:{...event.inputs,recovery_run_id:'1'}}},
  {event:{...event,inputs:{...event.inputs,action_id:'d'.repeat(64)}}},
  {event:{...event,inputs:{...event.inputs,issue_number:'3434'}}},
  {event:{...event,inputs:{...event.inputs,source_publisher_run_id:'43607502469'}}},
  {sourceRun:{...sourceRun,id:1}},
  {sourceRun:{...sourceRun,run_attempt:2}},
  {sourceRun:{...sourceRun,actor:{login:'BestNathan'}}},
  {sourceRun:{...sourceRun,path:'.github/workflows/agent-review.yml'}},
  {sourceRun:{...sourceRun,event:'push'}},
  {sourceRun:{...sourceRun,status:'queued'}},
  {sourceRun:{...sourceRun,status:'completed',conclusion:'failure'}},
  {sourceRun:{...sourceRun,head_branch:'staging'}},
  {sourceRun:{...sourceRun,head_sha:'oops'}},
  {sourceRun:{...sourceRun,repository:{full_name:'fork/nession'}}},
  {jobs:{total_count:2,jobs:[{...jobs.jobs[0]},{...jobs.jobs[1],
    status:'in_progress'}]}},
  {jobs:{total_count:2,jobs:[jobs.jobs[0],{...jobs.jobs[1],
    conclusion:'failure'}]}},
  {jobs:{total_count:2,jobs:[jobs.jobs[1],jobs.jobs[1]]}},
  {jobs:{total_count:3,jobs:jobs.jobs}},
  {jobs:{total_count:2,jobs:[jobs.jobs[0],{...jobs.jobs[1],
    steps:[{...jobs.jobs[1].steps[0],conclusion:'failure'}]}]}},
  {storeSource:{...storeSource,publisher_run_id:123}},
  {storeSource:{...storeSource,reviewer_action_id:'d'.repeat(64)}},
  {storeSource:{...storeSource,issue:3434}},
  {storeSource:{...storeSource,branch:'refs/heads/random'}},
])reject(patch);
console.log('✓ publisher-reviewer-wake-selftest');
