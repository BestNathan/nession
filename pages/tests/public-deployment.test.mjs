import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// The privileged Pages deploy workflow must compare publicly served bytes to
// the exact artifact uploaded by the build job. A successful Pages upload or
// matching main SHA alone does not prove that Agent observations were served.
test('independent public deployment preserves exact anonymous JSON and observation receipt',async()=>{
 const yaml=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
 const required=[
  'public_data_sha256: ${{ steps.public_data.outputs.sha256 }}',
  'public_agent_source: ${{ steps.public_data.outputs.source }}',
  'public_agent_runs: ${{ steps.public_data.outputs.observed_runs }}',
  'EXPECTED_DATA_SHA256: ${{ needs.build.outputs.public_data_sha256 }}',
  'EXPECTED_AGENT_SOURCE: ${{ needs.build.outputs.public_agent_source }}',
  'EXPECTED_AGENT_RUNS: ${{ needs.build.outputs.public_agent_runs }}',
  'jq -e',
  '.work.agent_run_source',
  '[.work.issues[]?.agent_runs[]?] | length',
  '(.pr_linkage == "unlinked")',
  'sha256sum "$json"',
  '"$digest" == "$EXPECTED_DATA_SHA256"',
  '"$source" == "$EXPECTED_AGENT_SOURCE"',
  '"$observed" == "$EXPECTED_AGENT_RUNS"',
  'source_backed_observation',
  'status=not_observed',
  'Public Issue Agent Run observation:',
 ];
 for(const item of required) assert.ok(yaml.includes(item),'missing public observation guarantee: '+item);
 assert.ok(yaml.includes('"$url/data/site.json?revision=$EXPECTED_SHA"'));
 assert.match(yaml,/\.source\.main_sha == \$sha/);
 assert.doesNotMatch(yaml,/(?:^|\n)\s*-\s+name:.*(?:build|deploy).*web\//i);
});

test('same-main-SHA but stale CDN bytes must not end bounded publisher polling',async()=>{
 const yaml=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
 const start=yaml.indexOf('for attempt in {1..18}; do');
 const end=yaml.indexOf('          done',start);
 assert.ok(start>=0&&end>start,'bounded polling loop required');
 const poll=yaml.slice(start,end);
 const hash=poll.indexOf('digest="$(sha256sum "$json"');
 const source=poll.indexOf('source="$(jq -r .work.agent_run_source');
 const observed=poll.indexOf("observed=\"$(jq '[.work.issues[]?.agent_runs[]?] | length'");
 const expectDigest=poll.indexOf('"$digest" == "$EXPECTED_DATA_SHA256"');
 const expectSource=poll.indexOf('"$source" == "$EXPECTED_AGENT_SOURCE"');
 const expectCount=poll.indexOf('"$observed" == "$EXPECTED_AGENT_RUNS"');
 const success=poll.indexOf('matched=true');
 const stop=poll.indexOf('break',success);
 for(const p of [hash,source,observed,expectDigest,expectSource,expectCount]){
   assert.ok(p>=0&&p<success,'exact public digest/source/count must be checked before matching');
 }
 assert.ok(success>0&&stop>success&&stop<end-start);
 assert.match(poll,/if \[\[ "\$digest" == "\$EXPECTED_DATA_SHA256" &&\s*"\$source" == "\$EXPECTED_AGENT_SOURCE" &&\s*"\$observed" == "\$EXPECTED_AGENT_RUNS" \]\]; then/);
 assert.ok(!poll.includes('matched=true\n              break'), 'same-SHA/HTML cannot short circuit exact bytes');
 const after=yaml.slice(end,end+450);
 assert.match(after,/\[\[ "\$matched" == true \]\] \|\|/);
 assert.match(after,/exit 1/,'exhausted polls must fail closed, never accept stale bytes');
 assert.match(yaml,/\[\[ "\$EXPECTED_DATA_SHA256" =~ \^\[a-f0-9\]\{64\}\$ \]\]/);
 assert.match(yaml,/\[\[ "\$EXPECTED_AGENT_SOURCE" =~ \^\(available\|truncated\|unavailable\)\$ \]\]/);
});
