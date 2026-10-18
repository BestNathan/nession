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
  '"$digest" != "$EXPECTED_DATA_SHA256"',
  '"$source" != "$EXPECTED_AGENT_SOURCE"',
  '"$observed" != "$EXPECTED_AGENT_RUNS"',
  'source_backed_observation',
  'status=not_observed',
  'Public Issue Agent Run observation:',
 ];
 for(const item of required) assert.ok(yaml.includes(item),'missing public observation guarantee: '+item);
 assert.ok(yaml.includes('"$url/data/site.json?revision=$EXPECTED_SHA"'));
 assert.match(yaml,/\.source\.main_sha == \$sha/);
 assert.doesNotMatch(yaml,/(?:^|\n)\s*-\s+name:.*(?:build|deploy).*web\//i);
});
