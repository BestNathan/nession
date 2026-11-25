'use strict';
// #4436 SC-02: the published knowledge artifact is verifiable from the exact
// target checkout: fetch the public orphan `knowledge` branch anonymously, run
// the canonical ledger validator against it, and check that the four WebSocket
// Runtime V2 articles exist with the expected status, exact-commit sources,
// reciprocal cross-links and appended global CHANGELOG events. The trusted
// Publisher Run/readback remains the authenticated publication evidence; this
// Case proves the artifact is readable, internally consistent and current.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');

const EXPECTED = [
  {
    title: 'Nession WebSocket runtime architecture and message dispatch',
    status: 'verified',
    links: ['websocket-execution-budgets-and-backpressure.md'],
  },
  {
    title: 'WebSocket execution budgets and backpressure',
    status: 'verified',
    links: ['nession-websocket-runtime-architecture-and-message-dispatch.md'],
  },
  {
    title: 'WebSocket stream delivery and recovery',
    status: 'candidate',
    links: ['websocket-runtime-observability-and-reliability.md'],
  },
  {
    title: 'WebSocket runtime observability and reliability',
    status: 'candidate',
    links: ['websocket-stream-delivery-and-recovery.md'],
  },
];

run(({ evidence }) => {
  const sha = targetSha();
  // The ledger validator proves the orphan root, migration base and baseline
  // are ancestors of the head, so the knowledge history must not stop at a
  // shallow boundary. `--deepen` targets this ref and leaves the target
  // checkout's own shallow depth alone.
  checked(
    'git',
    ['fetch', '--deepen=500', 'origin', 'refs/heads/knowledge:refs/remotes/origin/knowledge'],
    300_000,
  );
  const head = checked('git', ['rev-parse', 'origin/knowledge'], 10_000).trim();
  const parent = checked('git', ['rev-parse', 'origin/knowledge^'], 10_000).trim();
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(parent)) {
    throw new Error('the knowledge head/parent did not resolve to exact SHAs');
  }

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-4436-'));
  try {
    checked('git', ['worktree', 'add', '--detach', worktree, 'origin/knowledge'], 180_000);
    const ledger = checked(
      'node',
      ['scripts/knowledge-ledger-contract.mjs', 'check', worktree, parent],
      300_000,
    );
    if (!ledger.includes('knowledge-ledger-contract: PASS')) {
      throw new Error('knowledge ledger validation did not pass: ' + ledger.slice(-1200));
    }

    const index = JSON.parse(fs.readFileSync(path.join(worktree, 'index.json'), 'utf8'));
    const articles = Object.values(index.topics ?? {}).flat();
    for (const expected of EXPECTED) {
      const article = articles.find((entry) => entry.title === expected.title);
      if (!article) throw new Error('missing published knowledge article: ' + expected.title);
      if (article.status !== expected.status) {
        throw new Error(
          expected.title + ': status ' + article.status + ', expected ' + expected.status,
        );
      }
      const body = fs.readFileSync(path.join(worktree, article.path), 'utf8');
      if (!body.includes('https://github.com/BestNathan/nession/blob/')) {
        throw new Error(expected.title + ': no exact-commit canonical source');
      }
      for (const link of expected.links) {
        if (!body.includes(link)) {
          throw new Error(expected.title + ': missing reciprocal link ' + link);
        }
      }
    }

    const changelog = fs.readFileSync(path.join(worktree, 'CHANGELOG.md'), 'utf8');
    for (const expected of EXPECTED) {
      if (!changelog.includes('| create | ' + expected.title)) {
        throw new Error('missing global CHANGELOG create event: ' + expected.title);
      }
    }

    evidence.push({
      type: 'runtime',
      value:
        sha +
        ': knowledge head ' +
        head +
        ' (parent ' +
        parent +
        ') is readable anonymously; ledger check PASS; the four WS runtime articles ' +
        'exist with expected statuses, exact-commit sources, reciprocal links and changelog events',
    });
    return (
      'The published knowledge artifact is readable and internally consistent at its current ' +
      'head: the canonical ledger validates, and the four WebSocket Runtime V2 articles carry ' +
      'their verified/candidate status, exact-commit sources, reciprocal cross-links and ' +
      'global changelog events'
    );
  } finally {
    try {
      checked('git', ['worktree', 'remove', '--force', worktree], 120_000);
    } catch {
      // Best effort: the temp directory is outside the repository.
    }
  }
});
