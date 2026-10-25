#!/usr/bin/env node
// Owner: canonical Acceptance result contract. The trusted executor and the
// Agent runner share this module so a structurally invalid model result is
// rejected by exactly the same rule wherever it is first observed.
const RESULTS = new Map([
  ['pass', 'Pass'],
  ['pending', 'Pending'],
  ['fail', 'Fail'],
  ['n/a', 'N/A'],
  ['na', 'N/A'],
]);

const PLACEHOLDERS = new Set(['', '-', 'none', 'n/a', 'na', 'pending', 'tbd', 'todo', 'implementation pending']);

function evidenceArray(value) {
  if (typeof value === 'string') {
    const v = value.trim();
    return v ? [{ type: 'text', value: v }] : [];
  }
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('evidence must be a string or array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('evidence[' + index + '] must be an object');
    const type = String(item.type ?? '').trim();
    const evidence = String(item.value ?? '').trim();
    if (!type || !evidence) throw new Error('evidence[' + index + '] requires type and value');
    if (/[\r\n]/.test(type) || /[\r\n]/.test(evidence)) throw new Error('evidence must be single-line');
    return { type, value: evidence };
  });
}

export function normalizeCriterion(item) {
  if (!item || typeof item !== 'object') throw new Error('criterion result must be an object');
  const criterion = String(item.criterion ?? '').trim().toUpperCase();
  if (!/^SC-\d{2,}$/.test(criterion)) throw new Error('invalid criterion id: ' + (criterion || '(empty)'));
  const result = RESULTS.get(String(item.result ?? '').trim().toLowerCase());
  if (!result) throw new Error(criterion + ' has unsupported result ' + (item.result ?? '(empty)'));
  const summary = String(item.summary ?? '').trim();
  if (/[\r\n]/.test(summary)) throw new Error(criterion + ' summary must be single-line');
  const evidence = evidenceArray(item.evidence);
  const concrete = evidence.some((entry) => !PLACEHOLDERS.has(entry.value.toLowerCase()));
  if ((result === 'Pass' || result === 'N/A') && !concrete) throw new Error(criterion + ' ' + result + ' requires concrete evidence');
  if (result === 'N/A' && !summary) throw new Error(criterion + ' N/A requires a justification summary');
  if ((result === 'Fail' || result === 'Pending') && !summary && evidence.length === 0) {
    throw new Error(criterion + ' ' + result + ' requires evidence or an explanatory summary');
  }
  return { criterion, result, evidence, summary };
}

export function normalizeAcceptanceResult(context, raw, source = 'agent') {
  const input = Array.isArray(raw) ? { criteria: raw } : raw;
  if (!input || typeof input !== 'object' || !Array.isArray(input.criteria)) {
    throw new Error('acceptance result must contain a criteria array');
  }
  const expected = new Set(context.criteria.map((item) => item.criterion));
  const seen = new Set();
  const criteria = input.criteria.map((item) => {
    const normalized = normalizeCriterion(item);
    if (!expected.has(normalized.criterion)) throw new Error('unknown or wrong-stage criterion ' + normalized.criterion);
    if (seen.has(normalized.criterion)) throw new Error('duplicate criterion ' + normalized.criterion);
    seen.add(normalized.criterion);
    return normalized;
  });
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new Error('acceptance result is missing criteria: ' + missing.join(', '));
  return {
    schema_version: 1,
    issue: context.issue.number,
    stage: context.stage,
    contract_sha256: context.contract_sha256,
    run_id: context.run_id,
    target_ref: context.target_ref,
    deployment: context.deployment,
    source: String(source || 'unknown'),
    selected_criteria: [...expected],
    criteria,
  };
}
