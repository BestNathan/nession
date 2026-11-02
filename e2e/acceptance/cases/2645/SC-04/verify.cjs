'use strict';
// #2645 SC-04: renewal is transport-neutral. It rebuilds the current chosen
// candidate and never rewrites the route intent; Auto keeps its existing
// candidate rotation/force-relay policy and pinned P2P keeps its pinned route.
// The real three-runtime Auto and pinned scenarios run in the staging Case.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { readSource, runWebTests } = require('../../../shared/p2p-credential-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const policyTests = runWebTests(
    ['src/platform/attach/__tests__/unit/AddressAttachPolicy.test.ts'],
  );
  const routeTests = runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'route intent change',
  );
  const manualTests = runWebTests(
    ['src/platform/session-runtime/__tests__/unit/SessionRuntime.test.ts'],
    'transport-exhausted for manual route disconnect',
  );

  const runtime = readSource('web/src/platform/session-runtime/SessionRuntime.ts');
  for (const [text, label] of [
    ['this.addressPolicy.activeUrl', 'renewal rebuilds the currently chosen candidate'],
    ['resolveUrl: (attempt) => this.resolveP2PUrl(attempt)', 'same transport, renewed credential'],
    ['effectiveForcedRelay', 'relay intent is never bypassed by renewal'],
  ]) {
    if (!runtime.includes(text)) {
      throw new Error('missing ' + label + ' (' + text + ')');
    }
  }

  evidence.push(
    {
      type: 'test',
      value:
        'exact SHA ' + sha + ': ' + (policyTests + routeTests + manualTests) +
        ' address-policy/route tests passed (Auto rotation, route-intent change, pinned-route exhaustion)',
    },
    {
      type: 'source',
      value:
        'exact SHA ' + sha +
        ': renewal reuses addressPolicy.activeUrl and keeps the existing relay/candidate policy; it introduces no route decision of its own',
    },
  );
  return 'Renewal rebuilds the same chosen route under the existing Auto and pinned P2P policies; it never rewrites transport intent';
});
