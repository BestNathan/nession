#!/usr/bin/env node
// Canonical PR Quality applicability. Invariants remain owned by gates/checks.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function selectQualityFamilies(paths) {
  if (!Array.isArray(paths) || !paths.length ||
      paths.some(p => typeof p !== 'string' || !p || p.includes('\0') ||
        p.startsWith('/') || p.split('/').includes('..'))) {
    return {rust:true, web:true, tooling:true, workflow:true, instruction:true, applicability:'unknown'};
  }
  const r={rust:false, web:false, tooling:false, workflow:false, instruction:false, applicability:'scoped'};
  for(const p of paths) {
    if(/^(?:AGENTS|CLAUDE)\.md$|\/(?:AGENTS|CLAUDE)\.md$/.test(p) ||
       p.startsWith('.claude/skills/') || p.startsWith('.agents/skills/')) {
      r.instruction=true;
    } else if(p.startsWith('.github/workflows/')) {
      r.workflow=true;
      if(p==='.github/workflows/ci-quality.yml')r.rust=r.web=r.tooling=true;
      else if(p==='.github/workflows/acceptance-case-smoke.yml')r.tooling=true;
    } else if(/^e2e\/fixtures\/agent-development\/[^/]+\.md$/.test(p)) {
      // Provider fixture: E2E's independent trusted Issue/impact plan owns runtime risk.
    } else if(p.startsWith('crates/')) {
      r.rust=true;
      if(/^crates\/nession-protocol(?:-codegen)?\//.test(p))r.web=r.tooling=true;
    } else if(p.startsWith('web/') || p.startsWith('design/') || p.startsWith('docs/design/')) {
      r.web=r.tooling=true;
    } else if(p.startsWith('e2e/')) {
      r.tooling=true;
    } else if(p.startsWith('gates/')) {
      r.tooling=true;
      if(/^gates\/checks\/rust-|^gates\/suites\/quality-rust\.gates$/.test(p))r.rust=true;
      else if(/^gates\/checks\/web-|^gates\/checks\/design-|^gates\/suites\/quality-web\.gates$/.test(p))r.web=true;
      else if(p!=='gates/suites/quality-tooling.gates')r.rust=r.web=true;
    } else if(p.startsWith('scripts/')) {
      r.tooling=true;
      if(/^scripts\/(?:check-coverage|filtered-test|check-test-isolation|check-tmux-socket)/.test(p))r.rust=true;
      else if(/^scripts\/(?:check-design-tokens|filtered-web-test)/.test(p) || p.startsWith('scripts/ci/web-build-artifact'))r.web=true;
      else if(/^scripts\/protocol-gate/.test(p))r.rust=r.web=true;
      else if(/^scripts\/(?:ci\/quality-scope|ci\/case-smoke|acceptance-|issue-|e2e-|workflow-|gate-|lib\/agent\/|lib\/acceptance\/|lib\/e2e\/|lib\/issue\/|lib\/workflow\/|detector-selftest-coverage|collect-repo-health|repo-)/.test(p)) {
        // Tooling-only source, exercised through the full canonical tooling suite.
      } else r.rust=r.web=true;
    } else if(p.startsWith('docs/') || /^(?:README|VISION|PRINCIPLE|PRODUCT)\.md$/.test(p)) {
      // Ordinary documentation cannot change Quality code or CI consumers.
    } else if(p.startsWith('automation/'))r.tooling=true;
    else if(/^(?:Cargo\.(?:toml|lock)|rust-toolchain\.toml|clippy\.toml)$/.test(p) || p.startsWith('.cargo/'))r.rust=true;
    else if(p==='justfile')r.rust=r.web=r.tooling=true;
    else {r.rust=r.web=r.tooling=true;r.applicability='unknown';}
  }
  return r;
}
const self=fileURLToPath(import.meta.url);
if(process.argv[1] && path.resolve(process.argv[1])===self) {
  try{
    if(!process.argv[2] || !process.env.GITHUB_OUTPUT)throw Error('usage: quality-scope.mjs NUL_PATH_FILE');
    const paths=fs.readFileSync(process.argv[2]).toString('utf8').split('\0').filter(Boolean);
    const result=selectQualityFamilies(paths);
    fs.appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(result).map(([k,v])=>k+'='+v).join('\n')+'\n');
    console.log('Quality applicability: '+JSON.stringify({paths:paths.length,...result}));
  }catch(e){console.error('Quality scope failed closed: '+e.message);process.exitCode=1;}
}
