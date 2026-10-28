'use strict';
// #2319 SC-04: the canonical trusted Case/ingester records SC-02 and SC-03
// evidence against their exact source SHA and SC contract. This Case reads the
// append-only `acceptance-results` branch and requires both records to be
// Pass, source-aligned, contract-consistent and ancestors of this target.
//
// At the staging push that first introduces the SC-02/SC-03 Cases their
// records do not exist yet, so this Case is Pending; a later staging target
// (or an exact-SHA replay after ingest) turns it into a Pass.
const h = require('../../../shared/staging-developer-cases.cjs');

h.emit(h.withAcceptanceResults((store) => {
  const sha = h.targetSha();
  const files = h.list(store.repo, store.ref, 'runs')
    .filter((file) => /\/2319\/SC-0[23]\.json$/.test(file));
  const records = files
    .map((file) => h.readJson(store.repo, store.ref, file))
    .filter((record) => record?.issue === 2319 &&
      record?.stage === 'staging' &&
      ['SC-02', 'SC-03'].includes(record?.criterion));

  const aligned = [];
  for (const record of records) {
    if (record.result !== 'Pass') continue;
    if (!Array.isArray(record.verifiers) || record.verifiers.length === 0 ||
        record.verifiers.some((verifier) => verifier.result !== 'Pass' ||
          !Array.isArray(verifier.evidence) || verifier.evidence.length === 0)) {
      continue;
    }
    if (record.case_revision !== record.target_sha) continue;
    if (h.stagedAncestor(record.target_sha) !== true) continue;
    aligned.push(record);
  }

  const latest = new Map();
  for (const record of aligned) {
    const previous = latest.get(record.criterion);
    if (!previous || record.run_id > previous.run_id) {
      latest.set(record.criterion, record);
    }
  }
  const missing = ['SC-02', 'SC-03'].filter((criterion) => !latest.has(criterion));
  if (missing.length > 0) {
    return h.pending(
      'The trusted Case/ingester has not yet recorded a Pass for ' +
      missing.join(', ') + ' at an ancestor of this staging target.',
      [{
        type: 'store',
        value: 'acceptance-results ' + store.ref + ': ' +
          (records.length === 0 ? 'no recorded 2319 SC-02/SC-03 result' :
            records.map((record) => record.criterion + '=' + record.result).join(',')) +
          '; target ' + sha,
      }],
    );
  }

  const sc02 = latest.get('SC-02');
  const sc03 = latest.get('SC-03');
  h.expect(h.HEX64.test(sc02.contract_sha256 ?? '') &&
    sc02.contract_sha256 === sc03.contract_sha256,
  'SC-02 and SC-03 were recorded against different SC contracts');
  for (const record of [sc02, sc03]) {
    h.expect(record.stage === 'staging', record.criterion + ' is not a staging record');
    h.expect(record.result === 'Pass', record.criterion + ' is not Pass');
    h.expect(record.case_revision === record.target_sha,
      record.criterion + ' Case revision is not its exact target SHA');
    h.expect(/^[a-f0-9]{40}$/.test(record.case_tree_sha ?? ''),
      record.criterion + ' has no exact Case tree SHA');
    h.expect(/^[a-f0-9]{64}$/.test(record.execution_id ?? ''),
      record.criterion + ' has no immutable execution id');
    h.expect(record.provenance?.verified_source?.head_sha === record.target_sha,
      record.criterion + ' provenance head differs from its target SHA');
  }

  return {
    status: 'pass',
    summary: 'The trusted Case/ingester recorded SC-02 (Run ' + sc02.run_id +
      ') and SC-03 (Run ' + sc03.run_id + ') as Pass against one SC contract ' +
      'at merged staging SHAs that are ancestors of ' + sha,
    evidence: [
      {
        type: 'store',
        value: 'acceptance-results ' + store.ref + ': SC-02 run ' + sc02.run_id +
          ' target ' + sc02.target_sha + ' tree ' + sc02.case_tree_sha +
          ' execution ' + sc02.execution_id + '; SC-03 run ' + sc03.run_id +
          ' target ' + sc03.target_sha + ' tree ' + sc03.case_tree_sha +
          ' execution ' + sc03.execution_id + '; contract ' + sc02.contract_sha256,
      },
      {
        type: 'runtime',
        value: 'exact staging target ' + sha + ': both records are Pass with ' +
          'non-empty verifier evidence, source-aligned case revisions and ' +
          'provenance heads, and their target SHAs are ancestors of this target',
      },
    ],
  };
}));
