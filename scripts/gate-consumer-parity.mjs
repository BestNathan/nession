#!/usr/bin/env node
// Repository quality consumers must not drop an existing blocking Gate during
// migration. This is a structural regression contract, not a second ruleset.
// Every invariant still lives in gates/checks/<id>.sh or its domain implementation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  [
    ".github/workflows/quality.yml",
    [
      "./gates/run --suite quality-rust",
      "./gates/run --suite quality-tooling",
      "./gates/run design-system-full web-eslint web-typecheck web-test-unit web-test-integration"
    ]
  ],
  [
    ".github/workflows/staging.yml",
    [
      "./gates/run --suite quality-rust",
      "./gates/run web-eslint web-typecheck web-test-unit web-test-integration",
      "./gates/run release-version-consistency"
    ]
  ],
  [
    ".github/workflows/release.yml",
    [
      "./gates/run release-version-consistency",
      "./gates/run --suite quality-rust",
      "./gates/run web-eslint web-typecheck web-test-unit web-test-integration"
    ]
  ],
  [
    ".github/workflows/e2e.yml",
    [
      "./gates/run design-system-browser",
      "./gates/run e2e-playwright"
    ]
  ],
  [
    ".github/workflows/requirement-acceptance.yml",
    [
      "./gates/run --suite acceptance-tooling",
      "./gates/run requirement-acceptance-pre-merge",
      "./gates/run requirement-acceptance-pr",
      "./gates/run requirement-acceptance-close"
    ]
  ],
  [
    ".github/workflows/acceptance.yml",
    [
      "./gates/run requirement-acceptance-selftest acceptance-executor-selftest acceptance-agent-selftest acceptance-ci-evidence-selftest",
      "./gates/run requirement-acceptance-selftest acceptance-executor-selftest"
    ]
  ],
  [
    ".github/workflows/e2e-scenario-smoke.yml",
    [
      "./gates/run terminal-attach-resume-selftest acceptance-runtime-contract"
    ]
  ],
  [
    ".github/workflows/acceptance-case-ingest.yml",
    [
      "./gates/run requirement-acceptance-selftest acceptance-executor-selftest acceptance-case-ingest-selftest"
    ]
  ],
  [
    ".github/workflows/agent-provider-smoke.yml",
    [
      "./gates/run agent-provider-contract acceptance-agent-selftest agent-workflow-telemetry"
    ]
  ],
  [
    ".github/workflows/issue-audit.yml",
    [
      "./gates/run issue-contract-selftest",
      "./gates/run issue-contract-selftest issue-audit-agent-selftest issue-audit-cursor-selftest"
    ]
  ],
  [
    ".github/workflows/metrics-ingest.yml",
    [
      "./gates/run agent-workflow-telemetry"
    ]
  ],
  [
    ".github/workflows/repo-metrics.yml",
    [
      "./gates/run repo-health-selftest repo-metrics-selftest agent-workflow-telemetry protocol-integrity"
    ]
  ],
  [
    "justfile",
    [
      "./gates/run --suite quality-rust",
      "./gates/run web-eslint web-typecheck",
      "./gates/run web-test-unit web-test-integration"
    ]
  ]
];
const legacy = /(?:^|\n)\s*(?:-\s*)?(?:run:\s*)?(?:node|bash)\s+(?:scripts|e2e)\/[^\n]*(?:\s(?:self-test|--self-test))(?:\s|$)/m;

function verify(load) {
  const problems = [];
  for (const [file, commands] of required) {
    const content = load(file);
    if (content == null) { problems.push(file + ': missing workflow/recipe'); continue; }
    const commandsInLines = new Set(content.split(/\r?\n/).map(line =>
      line.trim().replace(/^run:\s*/, '')));
    for (const command of commands) {
      if (!commandsInLines.has(command)) problems.push(file + ': missing canonical consumer ' + command);
    }
    if (file.startsWith('.github/workflows/') && legacy.test(content)) {
      problems.push(file + ': legacy raw Node/Bash self-test command remains outside the Gate runner');
    }
  }
  const suite = load('gates/suites/quality-tooling.gates');
  if (!suite || !/^gate-consumer-parity$/m.test(suite)) {
    problems.push('quality-tooling: consumer parity Gate is not required in PR CI');
  }
  return problems;
}
const source = new Map([...required.map(([file]) => file), 'gates/suites/quality-tooling.gates']
  .map(file => [file, fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null]));
function original(file) { return source.get(file) ?? null; }
assert.deepEqual(verify(original), [], 'baseline consumer/quality catalog must be valid');
let cases = 0;
for (const [file, commands] of required) {
  // Mutation tests exercise the same real parser against each consumer.
  for (const command of commands) {
    const altered = new Map(source);
    const old = altered.get(file);
    assert.ok(old && old.includes(command), 'fixture command missing: ' + file);
    altered.set(file, old.split(/\r?\n/).map(line =>
      line.trim().replace(/^run:\s*/, '') === command
        ? line.replace(command, './gates/run missing-contract-fixture')
        : line).join('\n'));
    const problems = verify(p => altered.get(p) ?? null);
    assert.ok(problems.some(p => p.includes(file + ': missing canonical consumer ' + command)),
      'removed consumer escaped contract: ' + file + ' ' + command);
    cases++;
  }
}
const first = '.github/workflows/issue-audit.yml';
const fixture = new Map(source);
fixture.set(first, fixture.get(first) + '\n      - run: node scripts/issue-contract.mjs self-test\n');
assert.ok(verify(p => fixture.get(p) ?? null).some(p => p.includes('legacy raw Node/Bash')),
  'raw self-test reintroduction escaped detection');
cases++;
const missing = new Map(source);
missing.set('gates/suites/quality-tooling.gates',
  missing.get('gates/suites/quality-tooling.gates').replace(/^gate-consumer-parity$/m, '# gate removed'));
assert.ok(verify(p => missing.get(p) ?? null).some(p => p.includes('consumer parity Gate')),
  'removing contract from PR quality suite escaped detection');
cases++;
console.log('gate-consumer-parity: ' + cases + ' mutation/negative fixtures passed');
