import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectQualityFamilies as choose} from './quality-scope.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const none={rust:false,web:false,tooling:false,workflow:false,instruction:false};
const flags=xs=>{const {applicability,...result}=choose(xs);return result;};
test('fixture-only, web-only, rust-only and terminal protocol diffs',()=>{
  assert.deepEqual(flags(['e2e/fixtures/agent-development/qwen-repair-source.md']),none);
  assert.deepEqual(flags(['web/src/product/terminal/index.tsx']),{...none,web:true,tooling:true});
  assert.deepEqual(flags(['crates/nession-agent/src/session/runtime.rs']),{...none,rust:true});
  assert.deepEqual(flags(['crates/nession-protocol/src/contracts/terminal/v1.rs','web/src/generated/protocol/a.ts']),{...none,rust:true,web:true,tooling:true});
});
test('changed owners select affected Gates',()=>{
  assert.deepEqual(flags(['gates/checks/rust-coverage.sh']),{...none,rust:true,tooling:true});
  assert.deepEqual(flags(['gates/run']),{...none,rust:true,web:true,tooling:true});
  assert.deepEqual(flags(['.github/workflows/ci-quality.yml']),{...none,rust:true,web:true,tooling:true,workflow:true});
  assert.deepEqual(flags(['docs/AGENTS.md']),{...none,instruction:true});
  assert.deepEqual(flags(['.github/workflows/agent-controller-dispatch.yml']),{...none,workflow:true});
});
test('unknown paths and unprovable diffs fail conservatively',()=>{
  assert.deepEqual(flags(['scripts/new-checker.sh']),{...none,rust:true,web:true,tooling:true});
  for(const xs of [[],[''],['../escape'],[123],null]){
    const r=choose(xs);assert.ok(r.rust&&r.web&&r.tooling&&r.workflow&&r.instruction);
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
