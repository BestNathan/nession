'use strict';
// #2010 SC-06: the parent Issues are updated with exact Run/Case receipts and
// their success criteria were checked only after formal Acceptance, not from a
// source merge alone.
const {
  assert, api, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const [parent1664, parent2274] = await Promise.all([
    api('/issues/1664'),
    api('/issues/2274'),
  ]);
  for (const [issue, expectedRows] of [[parent1664, 18], [parent2274, 5]]) {
    assert.equal(issue.state, 'closed',
      'parent Issue #' + issue.number + ' is not closed');
    const rows = String(issue.body).split('\n')
      .filter(line => /^\| SC-\d{2} \|/.test(line));
    assert.equal(rows.length, expectedRows,
      'parent Issue #' + issue.number + ' lost SC rows');
    assert.ok(rows.every(row => /\| Pass \|/.test(row)),
      'parent Issue #' + issue.number + ' contains a non-Pass SC');
    assert.match(String(issue.body), /run \d+/,
      'parent Issue #' + issue.number + ' lacks exact Run receipts');
    assert.match(String(issue.body), /case: execution=/,
      'parent Issue #' + issue.number + ' lacks exact Case receipts');
  }
  pass(
    'Parent #1664 and #2274 are closed with every Success Criterion Pass and exact Run/Case receipts recorded; their success was checked only after formal Acceptance, not from source merge alone.',
    [
      { type: 'runtime', value: 'parent #1664 is closed with 18/18 SC rows Pass and exact run/case receipts' },
      { type: 'runtime', value: 'parent #2274 is closed with 5/5 SC rows Pass and exact run/case receipts' },
    ],
  );
}

main().catch(fail);
