'use strict';
// #2839 SC-01: a sweep over two Agents x ten blackholed addresses must settle
// every status within a bounded deadline materially below the serial
// 20 x timeout baseline, while its dial fixture proves both the probe count
// and the concurrency bound. The fixture is a controlled blackhole, so the
// measurement does not depend on external network behavior.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'probe_sweep::sc01_bounded_sweep_settles_twenty_blackholed_addresses_without_unbounded_concurrency';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--test', 'integration', 'probe_sweep::sc01_'],
    300000,
  );
  assertRan(output, [TEST]);

  const measured = /#2839 SC-01 measured: ([^\n]+)/.exec(output);
  if (!measured) throw new Error('the SC-01 measurement line is missing');

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': two registered Agents x ten blackholed addresses, ' +
      '100 ms per-address timeout, 8-way sweep bound — ' + measured[1] +
      '; the dial fixture counted every probe, filled but never exceeded the bound, ' +
      'the elapsed time is below half the serial 20 x timeout baseline, and every ' +
      'registry status settled to Unreachable',
  });
  return 'Twenty blackholed addresses settle concurrently under a measured global bound';
});
