'use strict';
// #2877 SC-06: one bounded scripted workload measures the notification-mode
// candidate against the v1 operation baseline on the same CI runner.
//
// Candidate: a healthy notification subscriber plus a slow one that opts into
// credit and then never acknowledges. Baseline: the v1 output.applied operation
// on a third subscriber, whose accepted reports are exactly the frames the
// handler answers. A 256 x 4 KiB burst, one 256 KiB high-output event and a
// duplicate quiet tail are issued to each; the test records real ledger peaks.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'sc06_bounded_workload_measures_zero_progress_replies_and_per_subscriber_credit_peaks';
const MEASURED = /#2877 SC-06 measured: ([^\n]+)/;

function field(measurement, name) {
  const match = new RegExp(name + '=(\\d+)').exec(measurement);
  if (!match) throw new Error('the measurement line is missing ' + name);
  return Number(match[1]);
}

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-agent', ['--lib', TEST], 300000);
  assertRan(output, [TEST]);

  const match = MEASURED.exec(output);
  if (!match) throw new Error('the SC-06 measurement line is missing');
  const measurement = match[1];

  const progressFrames = field(measurement, 'progress_response_frames');
  const v1Replies = field(measurement, 'v1_operation_replies');
  const notices = field(measurement, 'reconcile_notices');
  const fastPeak = field(measurement, 'fast_credit_peak_bytes');
  const slowPeak = field(measurement, 'slow_credit_peak_bytes');
  const missed = field(measurement, 'missed_events');
  const capViolations = field(measurement, 'cap_violations');
  const quietReports = field(measurement, 'quiet_tail_reports');
  const quietReplies = field(measurement, 'quiet_tail_replies');

  if (progressFrames !== 0) {
    throw new Error('normal notification Progress produced ' + progressFrames + ' response frames');
  }
  if (v1Replies <= 0) throw new Error('the v1 baseline produced no answered operations');
  if (notices !== 1) throw new Error('expected one coalesced reconcile notice, got ' + notices);
  if (missed !== 0) throw new Error(missed + ' scripted events were not issued');
  if (capViolations !== 0) throw new Error(capViolations + ' credit-capacity violations');
  if (fastPeak <= 0 || slowPeak <= fastPeak) {
    throw new Error('credit peaks did not separate healthy and slow subscribers: ' +
      fastPeak + ' vs ' + slowPeak);
  }
  if (quietReports !== 1 || quietReplies !== 0) {
    throw new Error('the quiet tail must be silent in notification mode');
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': ' + measurement +
      '; the same 257-event workload answered zero notification Progress frames versus ' +
      v1Replies + ' v1 operation replies, emitted one coalesced notice, kept the slow ' +
      'subscriber credit peak at ' + slowPeak + ' bytes (healthy ' + fastPeak +
      ') inside the 2 MiB window, and completed with no missed event, capacity ' +
      'violation, notice storm or teardown failure',
  });
  return 'Notification mode answers zero ordinary Progress frames versus v1 replies; measured credit peaks and the bounded workload stay inside policy';
});
