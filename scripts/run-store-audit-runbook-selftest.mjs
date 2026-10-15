#!/usr/bin/env node
// Blocking activation runbook safety contract, not a substitute for live Rulesets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const wf=fs.readFileSync('.github/workflows/ci-run-store-integrity-audit.yml','utf8');
const doc=fs.readFileSync('docs/architecture/run-store-integrity-audit-runbook.md','utf8');
assert.match(wf,/permissions:\s*\n\s*contents: read\b/);
assert.doesNotMatch(wf,/contents: write\b/);
assert.match(wf,/github\.ref == 'refs\/heads\/main'/);
assert.match(wf,/vars\.RUN_STORE_AUDIT_ENABLED == 'true'/);
assert.match(wf,/RUN_STORE_AUDIT_ANCHORS_JSON/);
for (const phrase of [
  'migration baseline','RUN_STORE_AUDIT_ANCHORS_JSON',
  'RUN_STORE_AUDIT_ENABLED=true','workflow_dispatch','not WORM',
  'force-push','read-only restore drill','do not update the baseline',
  'not an independent durable alert channel','Pending under #1690'
]) assert.ok(doc.includes(phrase), 'activation runbook missing: '+phrase);
console.log('Run Store audit activation/runbook safety contract passed');
