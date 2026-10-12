#!/usr/bin/env node
// Optional per-SC proof plan, compatible with legacy Acceptance Report stages.
// The intentionally small YAML subset is a contract, not a general YAML
// parser. Never evaluate YAML tags/anchors or untrusted source instructions.
import assert from 'node:assert/strict';

const STAGES = new Set(['pre-merge', 'staging', 'post-merge']);
const METHODS = new Set(['agent', 'case']);
const WHENS = new Set(['pr', 'merged', 'deployed']);
const FIELDS = new Set(['when', 'method', 'branch', 'environment']);

export function acceptancePlanSection(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^## Acceptance Plan\s*$/.test(line.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function parseContractYaml(section, errors) {
  const block = section.match(/^\x60{3}ya?ml\s*\n([\s\S]*?)\n\x60{3}\s*$/);
  if (!block) {
    errors.push('Acceptance Plan must be one fenced yaml block, with no surrounding text');
    return new Map();
  }
  const lines = block[1].split('\n');
  const result = new Map();
  let current = null, header = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (raw.includes('\t') || /[#&*!{}\[\]|>]/.test(raw)) {
      errors.push('Acceptance Plan uses unsupported YAML syntax: ' + raw.trim());
      continue;
    }
    if (!header) {
      if (raw !== 'acceptance:') {
        errors.push('Acceptance Plan root must be acceptance:');
        return result;
      }
      header = true;
      continue;
    }
    const criterion = raw.match(/^  (SC-\d{2,}):\s*$/);
    if (criterion) {
      current = criterion[1];
      if (result.has(current)) errors.push('duplicate Acceptance Plan criterion ' + current);
      else result.set(current, {});
      continue;
    }
    const field = raw.match(/^    ([a-z_]+): ([a-z0-9-]+)$/);
    if (!field || !current) {
      errors.push('invalid Acceptance Plan line: ' + raw);
      continue;
    }
    if (!FIELDS.has(field[1])) {
      errors.push(current + ' unsupported Acceptance Plan field ' + field[1]);
      continue;
    }
    const entry = result.get(current);
    if (Object.hasOwn(entry, field[1])) errors.push(current + ' duplicate Acceptance Plan field ' + field[1]);
    entry[field[1]] = field[2];
  }
  if (!header) errors.push('empty Acceptance Plan');
  return result;
}

export function planStage(entry) {
  if (entry.when === 'pr') return 'pre-merge';
  if (entry.when === 'merged' && entry.branch === 'staging') return 'staging';
  if (entry.when === 'merged' && entry.branch === 'main') return 'post-merge';
  if (entry.when === 'deployed') return 'post-merge'; // compatibility only, not merged-SHA proof
  return null;
}

export function validateAcceptancePlan(body, criteria, reportRows) {
  const section = acceptancePlanSection(body);
  if (section === null) return { plan: null, errors: [] };
  const errors = [];
  const plan = parseContractYaml(section, errors);
  const expected = new Set(criteria);
  for (const id of expected) if (!plan.has(id)) errors.push(id + ' missing Acceptance Plan entry');
  for (const [id, entry] of plan.entries()) {
    if (!expected.has(id)) errors.push('unknown Acceptance Plan criterion ' + id);
    if (!WHENS.has(entry.when)) errors.push(id + ' unsupported when ' + (entry.when ?? '(missing)'));
    if (!METHODS.has(entry.method)) errors.push(id + ' unsupported method ' + (entry.method ?? '(missing)'));
    if (entry.when === 'pr' && (entry.branch || entry.environment)) errors.push(id + ' pr plan must not specify branch/environment');
    if (entry.when === 'merged' && !['staging', 'main'].includes(entry.branch)) {
      errors.push(id + ' merged plan requires explicit staging/main branch');
    }
    if (entry.when === 'merged' && entry.environment) errors.push(id + ' merged plan cannot specify deployment environment');
    if (entry.when === 'deployed' && (!entry.environment || entry.branch)) {
      errors.push(id + ' deployed plan requires environment and no branch');
    }
    const legacy = reportRows.get(id);
    const stage = planStage(entry);
    if (stage && !STAGES.has(legacy?.stage)) errors.push(id + ' missing compatible legacy Acceptance Report stage');
    else if (stage && legacy?.stage !== stage) {
      errors.push(id + ' Acceptance Plan stage ' + stage + ' disagrees with Acceptance Report ' + legacy.stage);
    }
  }
  return { plan, errors };
}

export function isProofEligible(entry, stage, method) {
  if (!entry) return true; // explicit backward compatibility
  if (entry.method !== method) return false;
  if (entry.when === 'deployed') return false; // real deployment trigger required
  return planStage(entry) === stage;
}

function selfTest() {
  const criteria = ['SC-01', 'SC-02', 'SC-03', 'SC-04'];
  const stages = new Map([['SC-01', {stage:'pre-merge'}], ['SC-02', {stage:'staging'}],
    ['SC-03', {stage:'post-merge'}], ['SC-04', {stage:'post-merge'}]]);
  const plan = '## Acceptance Plan\n\n\x60\x60\x60yaml\nacceptance:\n' +
    '  SC-01:\n    when: pr\n    method: agent\n' +
    '  SC-02:\n    when: merged\n    branch: staging\n    method: case\n' +
    '  SC-03:\n    when: merged\n    branch: main\n    method: agent\n' +
    '  SC-04:\n    when: deployed\n    environment: production\n    method: case\n\x60\x60\x60';
  assert.deepEqual(validateAcceptancePlan('## Success Criteria\nNo plan', criteria, stages), {plan:null,errors:[]});
  const valid = validateAcceptancePlan(plan, criteria, stages);
  assert.deepEqual(valid.errors, []);
  assert.equal(isProofEligible(valid.plan.get('SC-01'), 'pre-merge', 'agent'), true);
  assert.equal(isProofEligible(valid.plan.get('SC-01'), 'pre-merge', 'case'), false);
  assert.equal(isProofEligible(valid.plan.get('SC-02'), 'staging', 'case'), true);
  assert.equal(isProofEligible(valid.plan.get('SC-03'), 'post-merge', 'agent'), true);
  assert.equal(isProofEligible(valid.plan.get('SC-04'), 'post-merge', 'case'), false);
  assert.match(validateAcceptancePlan(plan.replace('method: case', 'method: magic'), criteria, stages).errors.join('\n'), /unsupported method/);
  assert.match(validateAcceptancePlan(plan.replace('branch: staging', 'branch: main'), criteria, stages).errors.join('\n'), /disagrees/);
  assert.match(validateAcceptancePlan(plan.replace('  SC-04:\n    when: deployed\n    environment: production\n    method: case\n', ''), criteria, stages).errors.join('\n'), /missing Acceptance Plan/);
  assert.match(validateAcceptancePlan(plan.replace('  SC-04:', '  SC-02:'), criteria, stages).errors.join('\n'), /duplicate Acceptance Plan criterion/);
  assert.match(validateAcceptancePlan(plan.replace('environment: production', 'branch: staging'), criteria, stages).errors.join('\n'), /deployed plan requires/);
  assert.match(validateAcceptancePlan(plan.replace('acceptance:', 'something:'), criteria, stages).errors.join('\n'), /root must be acceptance/);
  assert.match(validateAcceptancePlan(plan.replace('method: agent', 'method: &agent'), criteria, stages).errors.join('\n'), /unsupported YAML syntax/);
  console.log('acceptance-plan: schema and eligibility scenarios passed');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  if (process.argv[2] !== 'self-test') throw new Error('usage: acceptance-plan.mjs self-test');
  selfTest();
}
