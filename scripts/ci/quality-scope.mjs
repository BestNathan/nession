#!/usr/bin/env node
// Canonical PR Quality applicability. Invariants remain owned by gates/checks.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const FAMILIES=['rust','web','tooling','workflow','instruction','native'];
const instructionPath=p=>/(^|\/)(?:AGENTS|CLAUDE)\.md$/.test(p) ||
  p.startsWith('.claude/skills/') || p.startsWith('.agents/skills/');
const cargoPath=p=>/^(?:Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?|clippy\.toml|\.clippy\.toml|rustfmt\.toml|\.rustfmt\.toml)$/.test(p) || p.startsWith('.cargo/');
const workflowPath=p=>p.startsWith('.github/workflows/') || p.startsWith('.github/actions/');
const providerFixture=p=>/^e2e\/fixtures\/agent-development\/[^/]+\.md$/.test(p);
const rustScript=p=>/^scripts\/(?:check-coverage|filtered-test|rust-test-route|check-test-isolation|check-tmux-socket|check-codegen-drift|rustc-wrapper|seed-worktree-|build-cache-|server-handler-locality)/.test(p);
const webScript=p=>/^scripts\/(?:check-design-tokens|filtered-web-test|ci\/web-build-artifact)/.test(p);
const protocolScript=p=>/^scripts\/protocol-gate/.test(p);
const toolingScript=p=>/^scripts\/(?:ci\/quality-scope|ci\/case-smoke|acceptance-|issue-|e2e-|workflow-|gate-|lib\/agent\/|lib\/acceptance\/|lib\/e2e\/|lib\/issue\/|lib\/workflow\/|detector-selftest-coverage|collect-repo-health|repo-)/.test(p) ||
  /^scripts\/ci\/seal-gitops-secret(?:\.test)?\.mjs$/.test(p);
const nativeScript=p=>p==='scripts/native-macos-runtime-check.sh' ||
  p==='scripts/lib/native-macos-runtime-driver.mjs';
const rustGate=p=>/^gates\/checks\/rust-|^gates\/suites\/quality-rust\.gates$/.test(p);
const webGate=p=>/^gates\/checks\/(?:web-|design-)|^gates\/suites\/quality-web\.gates$/.test(p);
const sharedGate=p=>p.startsWith('gates/') && !rustGate(p) && !webGate(p) &&
  p!=='gates/suites/quality-tooling.gates';
const unknownScript=p=>p.startsWith('scripts/') && !rustScript(p) &&
  !webScript(p) && !protocolScript(p) && !toolingScript(p) && !nativeScript(p);
const qualityWorkflow=p=>p==='.github/workflows/ci-quality.yml';
const protocolCrate=p=>/^crates\/nession-protocol(?:-codegen)?\//.test(p);
const webInput=p=>p.startsWith('web/') || p.startsWith('design/') || p.startsWith('docs/design/');
const ordinaryDocs=p=>p.startsWith('docs/') || /^(?:README|VISION|PRINCIPLE|PRODUCT|THIRD_PARTY_NOTICES)\.md$/.test(p);
const deploymentInput=p=>p.startsWith('deploy/') || /^Dockerfile(?:\..+)?$/.test(p);
const hookInput=p=>p.startsWith('.githooks/') || p.startsWith('.claude/hooks/');
const nativeCrate=p=>/^crates\/nession-(?:agent|cli|server|common|runtime|tmux|sandbox|protocol|erofs|claude-code|git|github|mcp|client)\//.test(p);

// Each family owns its positive inputs and its unresolved regions. In
// particular unknown repository paths are NOT a Rust/Web/native dependency.
// A complete valid diff is distinct from an unavailable/empty integration diff.
// Keep unknown scripts/shared Gates conservative until their checker dependency
// closure is registered. Tooling owns unmatched-path diagnostics.
export function explainQualityFamilies(paths) {
  const result=Object.fromEntries(FAMILIES.map(f=>[f,false]));
  const reasons=Object.fromEntries(FAMILIES.map(f=>[f,[]]));
  const mark=(family,rule,p)=>{
    result[family]=true;
    reasons[family].push({rule,path:p});
  };
  const valid=Array.isArray(paths) && paths.every(p=>typeof p==='string' &&
    p.length>0 && !p.includes('\0') && !p.startsWith('/') &&
    p.split('/').every(segment=>segment!=='' && segment!=='.' && segment!=='..'));
  if(!valid || paths.length===0) {
    const rule=valid?'empty-integration-diff':'unverifiable-path-list';
    for(const f of FAMILIES)mark(f,rule,null);
    return {result:{...result,applicability:'unknown'},reasons,unknownPaths:[]};
  }
  const unknownPaths=[];
  for(const p of paths) {
    if(instructionPath(p)) {
      mark('instruction','instruction-owner',p);
      continue;
    }
    if(providerFixture(p))continue;
    let matched=false;
    const hit=(family,rule)=>{matched=true;mark(family,rule,p);};
    if(workflowPath(p))hit('workflow','actions-definition');
    if(qualityWorkflow(p)){
      for(const f of ['rust','web','tooling','native'])hit(f,'quality-workflow-owner');
    }
    if(p==='.github/workflows/release-production.yml')hit('native','native-release-workflow');
    if(p==='.github/workflows/acceptance-case-smoke.yml')hit('tooling','case-smoke-workflow');
    if(p.startsWith('crates/'))hit('rust','workspace-crate');
    if(protocolCrate(p)){
      hit('web','protocol-contract');
      hit('tooling','protocol-contract');
    }
    if(nativeCrate(p))hit('native','native-binary-dependency');
    if(cargoPath(p)){
      hit('rust','cargo-workspace-input');
      hit('native','cargo-workspace-input');
    }
    if(p.startsWith('web/src/generated/protocol/'))hit('rust','rust-codegen-output');
    if(webInput(p)){
      hit('web','web-design-input');
      hit('tooling','web-design-input');
    }
    if(p.startsWith('e2e/') || p.startsWith('automation/') || p.startsWith('pages/'))
      hit('tooling','repository-tooling-input');
    if(deploymentInput(p)){
      hit('rust','deployment-runtime-and-tmux-input');
      hit('tooling','deployment-tooling-input');
    }
    if(hookInput(p)){
      hit('tooling','hook-input');
      if(p.startsWith('.githooks/'))hit('instruction','instruction-hook-input');
      if(p==='.claude/hooks/create-worktree.sh')hit('rust','worktree-cache-input');
      if(p==='.githooks/pre-push')hit('web','pre-push-diff-contract');
    }
    if(p.startsWith('gates/')){
      hit('tooling','gate-catalog');
      if(rustGate(p))hit('rust','rust-gate-owner');
      if(webGate(p))hit('web','web-gate-owner');
      if(sharedGate(p)){
        hit('rust','shared-gate-fallback');
        hit('web','shared-gate-fallback');
      }
    }
    if(p.startsWith('scripts/')){
      hit('tooling','script-input');
      if(rustScript(p))hit('rust','rust-checker-owner');
      if(webScript(p))hit('web','web-checker-owner');
      if(protocolScript(p)){
        hit('rust','protocol-checker-owner');
        hit('web','protocol-checker-owner');
      }
      if(nativeScript(p))hit('native','native-fixture-owner');
      if(unknownScript(p)){
        hit('rust','unresolved-rust-checker-dependency');
        hit('web','unresolved-web-checker-dependency');
      }
    }
    if(p==='justfile'){
      for(const f of ['rust','web','tooling'])hit(f,'shared-recipe-owner');
    }
    if(!matched && !ordinaryDocs(p)){
      unknownPaths.push(p);
      hit('tooling','unclassified-repository-path');
    }
  }
  return {result:{...result,applicability:unknownPaths.length?'unknown':'scoped'},reasons,unknownPaths};
}

export function selectQualityFamilies(paths) {
  return explainQualityFamilies(paths).result;
}
const self=fileURLToPath(import.meta.url);
if(process.argv[1] && path.resolve(process.argv[1])===self) {
  try{
    if(!process.argv[2] || !process.env.GITHUB_OUTPUT)throw Error('usage: quality-scope.mjs NUL_PATH_FILE');
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(process.argv[2]));
    if(raw && !raw.endsWith('\0'))throw Error('unterminated Git NUL path list');
    const paths=raw?raw.slice(0,-1).split('\0'):[];
    const {result,reasons,unknownPaths}=explainQualityFamilies(paths);
    fs.appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(result).map(([k,v])=>k+'='+v).join('\n')+'\n');
    console.log('Quality applicability: '+JSON.stringify({paths:paths.length,...result}));
    console.log('Quality decision reasons: '+JSON.stringify({reasons,unknownPaths}));
  }catch(e){console.error('Quality scope failed closed: '+e.message);process.exitCode=1;}
}
