// Two independent bounded GitHub Actions workflow windows. A mixed first 100
// repo-level Runs cannot attest per-ID E2E + trusted Ingest at an older PR SHA.
const REPO='BestNathan/nession';
const SPECS=Object.freeze([
  {path:'.github/workflows/e2e-tests.yml',name:'E2E / Tests',event:'pull_request'},
  {path:'.github/workflows/e2e-test-ingest.yml',name:'E2E / Test Ingest',event:'workflow_run'},
]);
const sha=/^[a-f0-9]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const pathOf=r=>r?.path?.replace(/@refs\/heads\/[^\s]+$/,'');
// A GitHub API response must be a full, first-page window for *this* workflow.
// Reject duplicate/conflicting IDs rather than treating a poisoned window as Pass.
export function selectScopedE2ERuns(raw){
  if(!Array.isArray(raw)||raw.length!==2)return null;
  const records=[],seen=new Map();let truncated=false;
  for(let i=0;i<2;i++){
    const spec=SPECS[i],v=raw[i],list=v?.workflow_runs;
    if(!Array.isArray(list)||list.length>100||
       !Number.isSafeInteger(v.total_count)||v.total_count<list.length)return null;
    if(v.total_count>100||list.length===100)truncated=true;
    for(const r of list){
      if(!positive(r?.id)||!positive(r.run_attempt)||!sha.test(r.head_sha??'')||
         r.name!==spec.name||pathOf(r)!==spec.path||
         r.event!==spec.event||r.repository?.full_name!==REPO||
         (r.head_repository?.full_name!==REPO&&r.head_repository?.full_name!=null)||
         !['completed','queued','in_progress','waiting','pending','requested'].includes(r.status)||
         (r.status==='completed'&&
           !['success','failure','cancelled','timed_out','neutral','skipped','action_required'].includes(r.conclusion))||
         (i===1&&r.head_branch!=='main'))return null;
      if(seen.has(r.id))return null;
      seen.set(r.id,i);records.push(r);
    }
  }
  records.sort((a,b)=>b.id-a.id||b.run_attempt-a.run_attempt);
  return {runs:records,truncated};
}
export const scopedE2EPaths=Object.freeze(SPECS.map(x=>x.path));
