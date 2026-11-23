'use strict';
// #3990 SC-01: a protocol directory filled on physical socket G1 must answer
// `unknown` after that socket is lost and before G2's authoritative Agent
// list arrives. A replacement socket starts empty, a fresh snapshot — or no
// Agent at all — is the only thing it resolves against, and a delayed list
// response that settles on the later generation cannot republish G1's
// manifests.
const { run, targetSha, webVitestFiles } = require('../../../shared/web-vitest-cases.cjs');

const DIRECTORY = 'src/platform/protocol/__tests__/unit/directory.test.ts';
const TRANSPORT = 'src/platform/socket/__tests__/unit/WebSocketService.test.ts';
const AGENTS = 'src/product/agent/__tests__/unit/AgentsPlugin.test.ts';

const DIRECTORY_TESTS = [
  'forgets every target at a physical connection boundary',
];

const TRANSPORT_TESTS = [
  'empties the directory when a live socket is lost, before a replacement exists',
  'starts every replacement socket with no manifests inherited from its predecessor',
];

const AGENTS_TESTS = [
  'refuses a list response that settles after the physical socket moved on',
  'refuses a list response that settles once the connection is no longer live',
  'publishes a list whose request was queued behind the readiness gate',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitestFiles([DIRECTORY], DIRECTORY_TESTS, { project: 'unit' });
  webVitestFiles([TRANSPORT], TRANSPORT_TESTS, { project: 'unit' });
  webVitestFiles([AGENTS], AGENTS_TESTS, { project: 'unit' });
  evidence.push({
    type: 'protocol',
    value:
      'exact SHA ' + sha + ': after socket loss the directory answered `unknown` for the ' +
      'agent it had served as `present`; a replacement socket opened empty; a snapshot ' +
      'published in the reconnect window and a list response that settled on the later ' +
      'generation were both dropped, while a request queued behind the readiness gate ' +
      'published its current answer',
  });
  return 'the protocol directory forgets a lost socket and only a current-generation authoritative list can refill it';
});
