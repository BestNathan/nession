'use strict';
// #2877 SC-04: on a valid current reconciliation notice (and independently on
// a Web-observed gap) the Web executes one single-flight existing Resume from
// its trustworthy applied frontier; a complete ordered same-epoch replay
// restores progress without duplicate/skipped events; unavailable/incomplete
// replay takes the proven checkpoint/reattach path, never false sync.
const { run, targetSha, webVitestFiles } = require('../../../shared/web-vitest-cases.cjs');

const RUNTIME_FILE = 'src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts';
const RUNTIME_TESTS = [
  'recovers once from a valid reconcile notice, from the trusted parser prefix (#2877)',
  'ignores a stale or foreign reconcile notice and degrades when replay cannot prove continuity (#2877)',
  'takes the checkpoint path immediately when the Agent requires a fresh binding (#2877)',
];

const RECONCILER_FILE = 'src/platform/terminal-runtime/__tests__/unit/streamReconciler.test.ts';
const RECONCILER_TESTS = [
  'proves recovery from the trusted prefix and resolves only on a complete same-epoch answer (#2877)',
  'refuses to reconcile across a replaced epoch and reports an incomplete replay as no proof (#2877)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitestFiles([RUNTIME_FILE], RUNTIME_TESTS, { project: 'unit' });
  webVitestFiles([RECONCILER_FILE], RECONCILER_TESTS, { project: 'unit' });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a valid current notice started one resume from the last ' +
      'parser-applied prefix, suppressed progress while the proof was outstanding, and ' +
      'resumed only on a complete same-epoch answer; an incomplete replay, a replaced ' +
      'epoch and a renderer-replacement notice took the checkpoint/reattach path and ' +
      'left the terminal degraded; stale/foreign notices started nothing',
  });
  return 'Exactly one recovery from the trusted applied frontier; completeness and epoch are proven before resync, otherwise the terminal is explicitly degraded';
});
