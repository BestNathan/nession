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
  'workflow_json_sha256: ${{ steps.public_data.outputs.workflow_json_sha256 }}',
  'workflow_html_sha256: ${{ steps.public_data.outputs.workflow_html_sha256 }}',
  'workflow_nodes: ${{ steps.public_data.outputs.workflow_nodes }}',
  'public_agent_source: ${{ steps.public_data.outputs.source }}',
  'public_agent_runs: ${{ steps.public_data.outputs.observed_runs }}',
  'EXPECTED_DATA_SHA256: ${{ needs.build.outputs.public_data_sha256 }}',
  'EXPECTED_WORKFLOW_JSON_SHA256: ${{ needs.build.outputs.workflow_json_sha256 }}',
  'EXPECTED_WORKFLOW_HTML_SHA256: ${{ needs.build.outputs.workflow_html_sha256 }}',
  'EXPECTED_WORKFLOW_NODES: ${{ needs.build.outputs.workflow_nodes }}',
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
  '"$workflow_json_digest" == "$EXPECTED_WORKFLOW_JSON_SHA256"',
  '"$workflow_html_digest" == "$EXPECTED_WORKFLOW_HTML_SHA256"',
  '"$workflow_nodes" == "$EXPECTED_WORKFLOW_NODES"',
  '"$url/workflows.html?revision=$EXPECTED_SHA"',
  '"$url/data/workflows.json?revision=$EXPECTED_SHA"',
  'node pages/scripts/publication-receipt.mjs emit',
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
 const graphHash=poll.indexOf('workflow_json_digest="$(sha256sum "$workflow_json"');
 const htmlHash=poll.indexOf('workflow_html_digest="$(sha256sum "$workflow_html"');
 const graphCount=poll.indexOf('workflow_nodes="$(jq -r');
 const expectGraphHash=poll.indexOf('"$workflow_json_digest" == "$EXPECTED_WORKFLOW_JSON_SHA256"');
 const expectHtmlHash=poll.indexOf('"$workflow_html_digest" == "$EXPECTED_WORKFLOW_HTML_SHA256"');
 const expectGraphCount=poll.indexOf('"$workflow_nodes" == "$EXPECTED_WORKFLOW_NODES"');
 const graphUrl=poll.indexOf('"$url/data/workflows.json?revision=$EXPECTED_SHA"');
 const htmlUrl=poll.indexOf('"$url/workflows.html?revision=$EXPECTED_SHA"');
 const success=poll.indexOf('matched=true');
 const stop=poll.indexOf('break',success);
 for(const p of [hash,source,observed,expectDigest,expectSource,expectCount,
   graphHash,htmlHash,graphCount,expectGraphHash,expectHtmlHash,expectGraphCount,graphUrl,htmlUrl]){
   assert.ok(p>=0&&p<success,'exact public digest/source/count must be checked before matching');
 }
 assert.ok(success>0&&stop>success&&stop<end-start);
 assert.match(poll,/if \[\[ "\$digest" == "\$EXPECTED_DATA_SHA256" &&\s*"\$source" == "\$EXPECTED_AGENT_SOURCE" &&\s*"\$observed" == "\$EXPECTED_AGENT_RUNS" &&\s*"\$workflow_json_digest" == "\$EXPECTED_WORKFLOW_JSON_SHA256" &&\s*"\$workflow_html_digest" == "\$EXPECTED_WORKFLOW_HTML_SHA256" &&\s*"\$workflow_nodes" == "\$EXPECTED_WORKFLOW_NODES" \]\]; then/);
 assert.ok(!poll.includes('matched=true\n              break'), 'same-SHA/HTML cannot short circuit exact bytes');
 const after=yaml.slice(end,end+450);
 assert.match(after,/\[\[ "\$matched" == true \]\] \|\|/);
 assert.match(after,/exit 1/,'exhausted polls must fail closed, never accept stale bytes');
 assert.match(yaml,/\[\[ "\$EXPECTED_DATA_SHA256" =~ \^\[a-f0-9\]\{64\}\$ \]\]/);
 assert.match(yaml,/\[\[ "\$EXPECTED_WORKFLOW_JSON_SHA256" =~ \^\[a-f0-9\]\{64\}\$ \]\]/);
 assert.match(yaml,/\[\[ "\$EXPECTED_WORKFLOW_HTML_SHA256" =~ \^\[a-f0-9\]\{64\}\$ \]\]/);
 assert.match(yaml,/\[\[ "\$EXPECTED_AGENT_SOURCE" =~ \^\(available\|truncated\|unavailable\)\$ \]\]/);
});

test('MCP public readback delegates typed-v2 validation and preserves exact-byte guards',async()=>{
 const yaml=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
 const start=yaml.indexOf('if [[ -n "$EXPECTED_MCP_JSON_SHA256" ]]; then');
 const end=yaml.indexOf('echo "MCP Documents published:',start);
 assert.ok(start>=0&&end>start,'MCP exact-byte readback must be guarded');
 const readback=yaml.slice(start,end);
 // #3735 migrated the producer to schema v2. The publisher must consume
 // its canonical validator instead of independently pinning the old v1.
 assert.match(readback,/import \{validMcpPublication\} from "\.\/pages\/scripts\/mcp-reconcile\.mjs"/);
 assert.match(readback,/!validMcpPublication\(data\)/);
 assert.doesNotMatch(readback,/\.schema_version\s*==\s*1/);
 for(const invariant of [
   'data.source.sha !== process.argv[2]',
   'data.semantic_sha256 !== process.argv[3]',
   'data.tools.length !== Number(process.argv[4])',
   '"$EXPECTED_MCP_SOURCE_SHA" "$EXPECTED_MCP_SEMANTIC_SHA256" "$EXPECTED_MCP_TOOLS"',
   '"$EXPECTED_MCP_JSON_SHA256"',
   'sha256sum "$mcp_readback"',
   'mcp_ready=true',
   '[[ "$mcp_ready" == true ]] ||',
 ]) assert.ok(readback.includes(invariant),'MCP readback invariant lost: '+invariant);
 assert.doesNotMatch(readback,/mcp-documents\.js|EXPECTED_MCP_UI_SHA256/,
   'the removed fixed-JS proof must not be replaced by a same-origin JS hash');
 assert.match(readback,/for attempt in \{1\.\.18\}; do/,'readback must remain bounded');
 assert.match(readback,/MCP Documents public HTTPS bytes differ from validated build artifact/);
});

test('compiled Pages closure is a trusted-build manifest verified against anonymous bytes',async()=>{
 const yaml=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
 for(const required of [
  'artifact_manifest_sha256: ${{ steps.public_data.outputs.artifact_manifest_sha256 }}',
  'artifact_closure_sha256: ${{ steps.public_data.outputs.artifact_closure_sha256 }}',
  'artifact_files: ${{ steps.public_data.outputs.artifact_files }}',
  'EXPECTED_ARTIFACT_MANIFEST_SHA256: ${{ needs.build.outputs.artifact_manifest_sha256 }}',
  'EXPECTED_ARTIFACT_CLOSURE_SHA256: ${{ needs.build.outputs.artifact_closure_sha256 }}',
  'EXPECTED_ARTIFACT_FILES: ${{ needs.build.outputs.artifact_files }}',
  'node pages/scripts/artifact-manifest.mjs verify pages/dist',
  'sha256sum "$artifact_manifest"',
  'node pages/scripts/verify-published-artifact.mjs',
  '--manifest-sha "$EXPECTED_ARTIFACT_MANIFEST_SHA256"',
  '--main-sha "$EXPECTED_SHA"',
 ]) assert.ok(yaml.includes(required),'missing trusted closure manifest guarantee: '+required);
 assert.doesNotMatch(yaml,/mcp-documents\.js|EXPECTED_MCP_UI_SHA256/);
 const matched=yaml.indexOf('[[ "$matched" == true ]]');
 const verify=yaml.indexOf('node pages/scripts/verify-published-artifact.mjs');
 assert.ok(matched>=0&&verify>matched,'closure verification must follow exact JSON/HTML bytes');
 assert.match(yaml,/\[\[ "\$EXPECTED_ARTIFACT_MANIFEST_SHA256" =~ \^\[a-f0-9\]\{64\}\$ \]\]/);
 assert.match(yaml,/\[\[ "\$EXPECTED_ARTIFACT_FILES" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/);
});

test('Pages UI compilation is credential-isolated before the privileged projection',async()=>{
 const yaml=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
 const uiStart=yaml.indexOf('  ui:\n');
 const buildStart=yaml.indexOf('  build:\n');
 assert.ok(uiStart>=0&&buildStart>uiStart,'a credential-isolated ui job must precede build');
 const ui=yaml.slice(uiStart,buildStart);
 const build=yaml.slice(buildStart);
 assert.match(ui,/permissions:\n      contents: read/);
 assert.match(ui,/persist-credentials: false/);
 assert.match(ui,/npm ci --ignore-scripts/);
 assert.match(ui,/npm run check/);
 assert.match(ui,/npm run build:ui/);
 assert.match(ui,/name: pages-ui-\$\{\{ github\.run_attempt \}\}/);
 assert.doesNotMatch(ui,/GITHUB_TOKEN|secrets\.|\bVITE_/);
 assert.match(build,/needs: \[ui\]/);
 assert.match(build,/name: pages-ui-\$\{\{ github\.run_attempt \}\}/);
 assert.match(build,/PAGES_UI_DIR: \$\{\{ github\.workspace \}\}\/pages-ui/);
 assert.doesNotMatch(build,/npm run check|npm run build:ui/,
   'the credentialed projection job must not install or compile UI dependencies');
});

test('Pages publisher restores stable Cargo cache while preserving canonical source-backed publication',async()=>{
 const yaml=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
 const setupStart=yaml.indexOf('      - name: Prepare Rust toolchain for canonical Protocol codegen');
 const restoreStart=yaml.indexOf('      - name: Restore trusted main Pages Cargo cache',setupStart);
 const historicStart=yaml.indexOf('      - name: Restore SHA-keyed historical Protocol schemas',restoreStart);
 const generateStart=yaml.indexOf('      - name: Reconstruct missing historical Protocol schemas without credentials',historicStart);
 const buildStart=yaml.indexOf('      - name: Build sanitized static Pages artifact',generateStart);
 assert.ok(setupStart>=0&&restoreStart>setupStart&&historicStart>restoreStart&&generateStart>historicStart&&buildStart>generateStart);
 const setup=yaml.slice(setupStart,restoreStart),cache=yaml.slice(restoreStart,historicStart),historic=yaml.slice(historicStart,generateStart);
 assert.match(setup,/uses: actions-rust-lang\/setup-rust-toolchain@v1/);
 assert.match(setup,/cache: false/,'avoid hashes of unrelated runner-installed toolchain versions');
 assert.match(cache,/id: cargo_cache[\s\S]*uses: actions\/cache@v4/);
 for(const required of [
   '~/.cargo/registry/index','~/.cargo/registry/cache','~/.cargo/git','target',
   'runner.os','runner.arch','pages-main-cargo-v2-',
   "hashFiles('rust-toolchain.toml', 'Cargo.lock', 'Cargo.toml', '.cargo/config.toml', 'crates/**/Cargo.toml')",
   'steps.cargo_cache.outputs.cache-hit',
 ]) assert.ok(cache.includes(required),'missing stable Cargo cache property: '+required);
 assert.doesNotMatch(cache,/github\.run_id|github\.run_attempt|\.cargo\/bin|pages-main-codegen-v1/);
 assert.match(historic,/uses: actions\/cache@v4/);
 assert.ok(historic.includes('path: ${{ runner.temp }}/nession-protocol-schemas/schema-*.json'));
 assert.ok(historic.includes('pages-protocol-schemas-v1-'));
 const builder=await readFile(new URL('../scripts/build-data.mjs',import.meta.url),'utf8');
 assert.match(builder,/\['run','--quiet','-p','nession-protocol-codegen','--','--schema'\]/);
 assert.match(builder,/\['run','--quiet','-p','nession-mcp','--bin','nession-mcp-schema','--no-default-features'\]/);
 assert.match(yaml,/node pages\/scripts\/publish-prototypes\.mjs/);
 assert.match(yaml,/Verify public site URL and exact deployed main SHA/);
});

test('Pages retry selects the exact attempt-specific artifact rather than duplicate github-pages',async()=>{
 const yaml=await readFile(new URL('../../.github/workflows/deploy-pages.yml',import.meta.url),'utf8');
 const accepts=yaml.indexOf('        uses: actions/upload-pages-artifact@v3');
 const deploy=yaml.indexOf('        uses: actions/deploy-pages@v4',accepts);
 const readback=yaml.indexOf('      # Read only the exact trusted main code',deploy);
 assert.ok(accepts>0&&deploy>accepts&&readback>deploy);
 const uploadBlock=yaml.slice(accepts,deploy),deployBlock=yaml.slice(deploy,readback);
 const expected='github-pages-${{ github.run_attempt }}';
 const valid=(a,b)=>
   a.includes('uses: actions/upload-pages-artifact@v3') &&
   a.includes('with:') && a.includes('name: '+expected) &&
   a.includes('path: pages/dist') &&
   b.includes('uses: actions/deploy-pages@v4') &&
   b.includes('with:') && b.includes('artifact_name: '+expected);
 assert.ok(valid(uploadBlock,deployBlock),'upload and deployment must select the same run_attempt artifact');
 assert.equal(valid(uploadBlock.replace('name: '+expected, 'name: github-pages'),deployBlock),false,
   'unscoped upload must fail the contract');
 assert.equal(valid(uploadBlock,deployBlock.replace('artifact_name: '+expected, 'artifact_name: github-pages')),false,
   'unscoped deployment must fail the contract');
 assert.match(yaml,/Verify public site URL and exact deployed main SHA/);
 assert.match(yaml,/Build sanitized static Pages artifact/);
 assert.match(yaml,/pages-main-cargo-v2-/,'Cargo cache remains enabled on retries');
});
