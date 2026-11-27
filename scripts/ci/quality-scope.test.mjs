import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectQualityFamilies as choose,explainQualityFamilies as explain} from './quality-scope.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const none={rust:false,web:false,tooling:false,workflow:false,instruction:false,native:false};
const flags=xs=>{const {applicability,...result}=choose(xs);return result;};
test('fixture-only, web-only, rust-only and terminal protocol diffs',()=>{
  assert.deepEqual(flags(['e2e/fixtures/agent-development/qwen-repair-source.md']),none);
  assert.deepEqual(flags(['web/src/product/terminal/index.tsx']),{...none,web:true,tooling:true});
  assert.deepEqual(flags(['crates/nession-agent/src/session/runtime.rs']),{...none,rust:true,native:true});
  assert.deepEqual(flags(['crates/nession-protocol/src/contracts/terminal/v1.rs','web/src/generated/protocol/a.ts']),{...none,rust:true,web:true,tooling:true,native:true});
});
test('native macOS runtime family selects native-binary crates and their CI owners (#4584)',()=>{
  // Positive: the native runtime crates and the two workflows that own the
  // native job select native proof.
  for(const p of [
    'crates/nession-agent/src/session/process_discovery/macos.rs',
    'crates/nession-cli/src/commands/agent/start.rs',
    'crates/nession-server/src/main.rs',
    'crates/nession-common/src/config.rs',
    'crates/nession-runtime/src/lib.rs',
    'crates/nession-tmux/src/process.rs',
    'crates/nession-sandbox/src/lib.rs',
    'crates/nession-protocol/src/contracts/session/v1.rs',
    'crates/nession-erofs/src/lib.rs',
    'crates/nession-git/src/lib.rs',
    'crates/nession-github/src/lib.rs',
    'crates/nession-mcp/src/lib.rs',
    'crates/nession-claude-code/src/lib.rs',
    'crates/nession-client/src/lib.rs',
    'Cargo.lock', '.cargo/config.toml',
    'scripts/native-macos-runtime-check.sh', 'scripts/lib/native-macos-runtime-driver.mjs',
    '.github/workflows/ci-quality.yml',
    '.github/workflows/release-production.yml',
  ])assert.equal(flags([p]).native,true,'expected native for '+p);
  // Negative: codegen-only, Web and docs do not select native proof.
  for(const p of [
    'crates/nession-protocol-codegen/src/main.rs',
    'crates/nession-persistence-probes/src/lib.rs',
    'web/src/product/terminal/index.tsx',
    'docs/architecture/agent-process-discovery.md',
  ])assert.equal(flags([p]).native,false,'expected no native for '+p);
});
test('changed owners select affected Gates',()=>{
  assert.deepEqual(flags(['gates/checks/rust-coverage.sh']),{...none,rust:true,tooling:true});
  assert.deepEqual(flags(['gates/checks/rust-test-route-contract.sh']),{...none,rust:true,tooling:true});
  assert.deepEqual(flags(['scripts/rust-test-route.mjs']),{...none,rust:true,tooling:true});
  assert.deepEqual(flags(['scripts/filtered-test.sh']),{...none,rust:true,tooling:true});
  assert.deepEqual(flags(['gates/run']),{...none,rust:true,web:true,tooling:true});
  assert.deepEqual(flags(['.github/workflows/ci-quality.yml']),{...none,rust:true,web:true,tooling:true,workflow:true,native:true});
  assert.deepEqual(flags(['docs/AGENTS.md']),{...none,instruction:true});
  assert.deepEqual(flags(['.github/workflows/agent-controller-dispatch.yml']),{...none,workflow:true});
});
test('composite Actions are workflow surface, not unknown (#4593)',()=>{
  assert.deepEqual(flags(['.github/actions/install-regctl/action.yml']),{...none,workflow:true});
  assert.deepEqual(flags(['.github/actions/install-regctl/action.yml','.github/workflows/deploy-staging-acr.yml']),{...none,workflow:true});
});
test('unknown paths and unprovable diffs fail conservatively',()=>{
  assert.deepEqual(flags(['scripts/new-checker.sh']),{...none,rust:true,web:true,tooling:true});
  for(const xs of [[],[''],['../escape'],[123],null]){
    const r=choose(xs);assert.ok(r.rust&&r.web&&r.tooling&&r.workflow&&r.instruction&&r.native);
    assert.equal(r.applicability,'unknown');
  }
});
test('web-check remains required aggregate; main dist waits for it',()=>{
  const y=fs.readFileSync(path.join(root,'.github/workflows/ci-quality.yml'),'utf8');
  for(const s of [
    '  web-check:\n',
    'needs: [scope, tooling-check, web-tests]',
    'SCOPE_RESULT:',
    'TOOLING_RESULT:',
    'WEB_RESULT:',
    "if [[ \"$SCOPE_RESULT\" != 'success' ]]; then exit 1; fi",
    "if [[ \"$TOOLING_REQUIRED\" == 'true' && \"$TOOLING_RESULT\" != 'success' ]]; then exit 1; fi",
    "if [[ \"$WEB_REQUIRED\" == 'true' && \"$WEB_RESULT\" != 'success' ]]; then exit 1; fi",
    '  web-dist:\n    needs: [scope, web-check]'
  ])assert.ok(y.includes(s),'missing aggregate guard '+s);
  assert.match(y,/needs\.web-check\.result == 'success'/);
  assert.ok(y.includes('./gates/run --suite quality-tooling'));
  assert.ok(y.includes('./gates/run design-system-full web-eslint web-typecheck web-test-unit web-test-integration'));
});
test('Case Smoke selects before build, no-case PR skips runtime, main runs generic',()=>{
  const y=fs.readFileSync(path.join(root,'.github/workflows/acceptance-case-smoke.yml'),'utf8');
  const select=y.indexOf('- name: Select PR-linked Case-method proofs (trusted main policy)');
  assert.ok(select>0);
  for(const s of ['- uses: actions-rust-lang/setup-rust-toolchain@v1','- uses: actions/cache@v4','- name: Build runtime'])
    assert.ok(y.indexOf(s)>select,'expensive setup precedes selection: '+s);
  assert.ok(y.includes("if: steps.select.outputs.has_cases == 'true'"));
  assert.ok(y.includes("if: steps.select.outputs.needs_browser == 'true'"));
  assert.ok(y.includes('Select representative Case verifier classes'));
  assert.ok(y.includes('schedule:\n    - cron:'));
  assert.ok(y.includes('Not Required: no eligible source-aligned Cases'));
});

test('legacy PR heads use trusted Main selector without moving source SHA',()=>{
  const y=fs.readFileSync(path.join(root,'.github/workflows/ci-quality.yml'),'utf8');
  assert.ok(y.includes('- name: Checkout trusted Quality selector'));
  assert.ok(y.includes('ref: main\n          path: trusted'));
  assert.ok(y.includes('node trusted/scripts/ci/quality-scope.mjs "$RUNNER_TEMP/quality-changed-paths"'));
  assert.ok(y.includes('git diff --no-renames --name-only -z "$base" "$target"'));
  assert.ok(y.includes('[[ "$(git rev-parse HEAD)" == "$PR_HEAD_SHA" ]] || exit 1'));
});
test('Web dist proof does not treat no-artifact as a failed attestation',()=>{
  const y=fs.readFileSync(path.join(root,'.github/workflows/ci-web-dist-reuse-proof.yml'),'utf8');
  assert.ok(y.includes('- name: Report authenticated Web dist Not Required'));
  assert.ok(y.includes("if: steps.producer.outputs.applicable == 'false'"));
  for(const title of [
    'Checkout attested main source SHA', 'Install Web preview dependencies',
    'Download exact producer artifact', 'Restore verified exact-SHA dist',
    'Verify restored runnable Web preview parity',
    'Report bounded producer-consumer evidence'
  ]) {
    assert.ok(y.includes('- name: '+title+"\n        if: steps.producer.outputs.applicable == 'true'"),
      'inapplicable Main push must not execute '+title);
  }
  assert.ok(y.includes("printf -- '- Exact source SHA: "));
});


test('Secret sealing deployment changes are tooling-only, without weakening unknown or runtime routing',()=>{
  const scripts=['scripts/ci/seal-gitops-secret.mjs','scripts/ci/seal-gitops-secret.test.mjs'];
  const diff=['.github/workflows/deploy-seal-gitops-secret.yml',...scripts];
  for(const file of scripts) assert.deepEqual(flags([file]),{...none,tooling:true});
  assert.deepEqual(flags(diff),{...none,tooling:true,workflow:true});
  assert.deepEqual(flags([...diff,'crates/nession-server/src/main.rs']),{...none,rust:true,tooling:true,workflow:true,native:true});
  assert.deepEqual(flags([...diff,'web/src/main.tsx']),{...none,web:true,tooling:true,workflow:true});
  assert.deepEqual(flags(['scripts/ci/seal-gitops-secret-unknown.mjs']),{...none,rust:true,web:true,tooling:true});
});

test('unclassified valid paths use Tooling fallback, not heavy-family fanout (#4672)',()=>{
  for(const p of ['.mcp.json','.editorconfig','.new-dev-tool.json','new-area/settings.json','pages/src/app/App.tsx']){
    assert.deepEqual(flags([p]),{...none,tooling:true},p);
  }
  const r=explain(['.mcp.json']);
  assert.equal(r.result.applicability,'unknown');
  assert.deepEqual(r.unknownPaths,['.mcp.json']);
  assert.deepEqual(r.reasons.rust,[]);
  assert.deepEqual(r.reasons.native,[]);
  assert.deepEqual(r.reasons.web,[]);
  assert.deepEqual(r.reasons.tooling,[{rule:'unclassified-repository-path',path:'.mcp.json'}]);
  assert.deepEqual(flags(['.mcp.json','crates/nession-agent/src/lib.rs']),{...none,rust:true,tooling:true,native:true});
  assert.deepEqual(flags(['new-area/settings.json','web/src/main.tsx']),{...none,web:true,tooling:true});
  assert.deepEqual(flags(['.mcp.json','.github/workflows/release-production.yml']),{...none,tooling:true,workflow:true,native:true});
});
test('positive cross-boundary inputs and local fallback remain explicit',()=>{
  assert.deepEqual(flags(['Cargo.toml']),{...none,rust:true,native:true});
  assert.deepEqual(flags(['web/src/generated/protocol/example.ts']),{...none,rust:true,web:true,tooling:true});
  assert.deepEqual(flags(['deploy/entrypoint-agent.sh']),{...none,rust:true,tooling:true});
  assert.deepEqual(flags(['scripts/native-macos-runtime-check.sh']),{...none,native:true,tooling:true});
  assert.deepEqual(flags(['scripts/new-checker.sh']),{...none,rust:true,web:true,tooling:true});
  const unknown=explain(['scripts/new-checker.sh']);
  assert.equal(unknown.reasons.rust[0].rule,'unresolved-rust-checker-dependency');
  assert.equal(unknown.reasons.web[0].rule,'unresolved-web-checker-dependency');
  assert.deepEqual(unknown.reasons.native,[]);
  // --no-renames supplies both deleted and added paths; union is monotonic.
  assert.deepEqual(flags(['crates/nession-agent/src/old.rs','new-area/settings.json']),
    flags(['new-area/settings.json','crates/nession-agent/src/old.rs']));
  assert.equal(explain([]).reasons.rust[0].rule,'empty-integration-diff');
  assert.equal(explain(['../escape']).reasons.rust[0].rule,'unverifiable-path-list');
});
test('Cargo manifest path dependencies remain inside positive Rust input boundary',()=>{
  const workspace=fs.readFileSync(path.join(root,'Cargo.toml'),'utf8');
  const members=workspace.match(/\bmembers\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(members,'workspace member declaration');
  for(const [,member] of members[1].matchAll(/"([^"]+)"/g)){
    assert.ok(choose([member+'/Cargo.toml']).rust,'unregistered workspace member '+member);
    const manifest=fs.readFileSync(path.join(root,member,'Cargo.toml'),'utf8');
    for(const [,input] of manifest.matchAll(/\bpath\s*=\s*"([^"]+)"/g)){
      const resolved=path.relative(root,path.resolve(root,member,input)).split(path.sep).join('/');
      assert.ok(resolved && !resolved.startsWith('../'),'external manifest path '+input);
      // A local dependency directory is represented by its manifest; an
      // explicit source file is already a changed-path fact.
      const actual=resolved.endsWith('.rs')?resolved:resolved+'/Cargo.toml';
      assert.ok(choose([actual]).rust,'unregistered Cargo path dependency '+actual);
      if(choose([member+'/Cargo.toml']).native)
        assert.ok(choose([actual]).native,'unregistered native transitive input '+actual);
    }
  }
});

test('repository README is a real Rust CLI test input, not ordinary docs',()=>{
  assert.deepEqual(flags(['README.md']),{...none,rust:true});
  assert.deepEqual(flags(['docs/architecture/ordinary.md']),none);
  assert.equal(explain(['README.md']).reasons.rust[0].rule,'cli-documentation-contract-input');
});

// A bounded guard for statically discoverable source inputs. Rust macros and
// manifest-relative literals can refer outside the workspace crate subtree.
// Arbitrary dynamic paths cannot be proven by this scanner: the external
// input registration rule and owner review still apply.
function sourceInputReferences(file,text){
  const crate=file.split('/').slice(0,2).join('/');
  const out=[];
  const append=(value,relativeTo,kind)=>{
    const target=path.posix.normalize(path.posix.join(relativeTo,value.replace(/^\/+/,'')));
    out.push({target,kind});
  };
  for(const m of text.matchAll(/\binclude(?:_str|_bytes)?!\s*\(\s*(?:r#*)?"([^"\n]+)"/g))
    append(m[1],path.posix.dirname(file),'include');
  for(const m of text.matchAll(/#\s*\[\s*path\s*=\s*"([^"\n]+)"/g))
    append(m[1],path.posix.dirname(file),'include');
  for(const m of text.matchAll(/\bconcat!\s*\(\s*env!\s*\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*,\s*"([^"\n]+)"/g)){
    const embedded=/\binclude(?:_str|_bytes)?!\s*\(\s*$/.test(text.slice(0,m.index));
    append(m[1],crate,embedded?'include':'manifest-relative');
  }
  return out;
}
function unregisteredSourceInputs(file,text){
  return sourceInputReferences(file,text).filter(({target,kind})=>{
    // The WS baseline explicitly writes to this ignored output directory;
    // this is not a checked-in test input. Keep the exception source-bound.
    if(file==='crates/nession-runtime/tests/ws_runtime_baseline.rs' &&
       target==='target' && kind==='manifest-relative')return false;
    if(target==='..' || target.startsWith('../'))return true;
    if(!choose([target]).rust)return true;
    // Native builds can consume embedded resources outside the crate tree.
    // Do not require Native for Rust-only runtime test reads (e.g. CLI README).
    return kind==='include' && choose([file]).native && !choose([target]).native;
  });
}
test('external literal source input guard detects unregistered paths',()=>{
  const file='crates/nession-cli/tests/integration/cli_contract.rs';
  assert.deepEqual(unregisteredSourceInputs(file,'read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))'),[]);
  assert.deepEqual(unregisteredSourceInputs(file,'read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../new-area/settings.json"))'),[
    {target:'new-area/settings.json',kind:'manifest-relative'}
  ]);
  assert.deepEqual(unregisteredSourceInputs('crates/nession-agent/src/lib.rs','include_bytes!("../../../new-area/payload.bin")'),[
    {target:'new-area/payload.bin',kind:'include'}
  ]);
  assert.deepEqual(unregisteredSourceInputs('crates/nession-runtime/src/metrics.rs','include_str!("../assets/ws-runtime-dashboards.json")'),[]);
  // A registered Rust-only path is still insufficient for a native build input.
  assert.deepEqual(unregisteredSourceInputs('crates/nession-agent/src/lib.rs','include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))'),[
    {target:'README.md',kind:'include'}
  ]);
  assert.deepEqual(unregisteredSourceInputs('crates/nession-agent/src/lib.rs','#[path = "../../../new-area/module.rs"] mod external;'),[
    {target:'new-area/module.rs',kind:'include'}
  ]);
});
test('tracked Rust sources register statically discoverable build and test inputs',()=>{
  const failures=[];
  function visit(dir){
    for(const ent of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
      const rel=dir+'/'+ent.name;
      if(ent.isDirectory()){
        if(ent.name!=='target' && ent.name!=='.git')visit(rel);
      } else if(ent.isFile() && rel.endsWith('.rs')){
        const content=fs.readFileSync(path.join(root,rel),'utf8');
        for(const input of unregisteredSourceInputs(rel,content))
          failures.push(rel+' -> '+input.target+' ('+input.kind+')');
      }
    }
  }
  visit('crates');
  assert.deepEqual(failures,[],'register the actual Rust/native source input boundary');
  // This guard must execute when Rust source changes, not only on Tooling diffs.
  for(const suite of ['quality-rust','quality-tooling']){
    const contents=fs.readFileSync(path.join(root,'gates/suites/'+suite+'.gates'),'utf8');
    assert.ok(contents.split('\n').includes('ci-pr-routing-selftest'),'missing '+suite+' source-input guard');
  }
});
