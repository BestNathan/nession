'use strict';
// #2879 SC-04: a pinned Chromium memory Case.
//
// Run conditions (pre-registered before any candidate measurement):
//   - the production fixture's configured scrollback, not a test-only buffer;
//   - 1,000,000 output lines in writer-bounded chunks, then 200,000 more;
//   - forced V8 GC before every heap sample, five samples per checkpoint;
//   - growth is judged against max(8 MiB, 10% of the post-fill baseline), a
//     bound far below output-proportional retention for 200,000 lines;
//   - 32 Session replacements and 10 view detach/reattach cycles after the
//     measurement, then a final sample and retained-reference counts.
// The Case reports raw samples and spread, and asserts the plateau with
// DOM-reference, controller and link-provider counts — never RSS alone and
// never a unit mock.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { emitOrderedLines, openLifecycleFixture } = require('../../../shared/terminal-memory-lifecycle-cases.cjs');

const TOTAL_LINES = 1_000_000;
const EXTRA_LINES = 200_000;
const WARMUP_LINES = 20_000;
const CHUNK_LINES = 20_000;
const HEAP_SAMPLES = 5;
const HEAP_GROWTH_ABSOLUTE_BYTES = 8 * 1024 * 1024;
const HEAP_GROWTH_RATIO = 0.10;
const SESSION_ROTATIONS = 32;
const VIEW_CYCLES = 10;

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
};
const bytes = (value) => (value / (1024 * 1024)).toFixed(2) + ' MiB';

test('SC-04: 1,000,000 lines reach the configured scrollback and retained heap plateaus', async ({ page }) => {
  // The acceptance driver kills the verifier process at 120 s; fail with the
  // measurement message before that boundary rather than being SIGKILLed.
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  await openLifecycleFixture(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const sampleHeap = async () => {
    const samples = [];
    for (let index = 0; index < HEAP_SAMPLES; index += 1) {
      await cdp.send('HeapProfiler.collectGarbage');
      await page.waitForTimeout(30);
      const { usedSize } = await cdp.send('Runtime.getHeapUsage');
      samples.push(usedSize);
    }
    return samples;
  };

  const scrollback = await page.evaluate(
    () => window.clipboardHarness.lifecycle.snapshot().scrollback,
  );
  expect(scrollback).toBe(50_000);

  // Warm-up is deliberately separate from the baseline: the plateau claim is
  // about steady-state retention, not about first-fill allocation.
  const warmup = await emitOrderedLines(page, {
    from: 1, to: WARMUP_LINES, chunk: CHUNK_LINES, prefix: 'W',
  });
  const fill = await emitOrderedLines(page, {
    from: 1, to: TOTAL_LINES, chunk: CHUNK_LINES, prefix: 'B',
  });
  expect(fill.lines).toBe(TOTAL_LINES);
  expect(fill.tail).toBe('B' + TOTAL_LINES);
  const baseline = await sampleHeap();

  const extra = await emitOrderedLines(page, {
    from: 1, to: EXTRA_LINES, chunk: CHUNK_LINES, prefix: 'C',
  });
  expect(extra.tail).toBe('C' + EXTRA_LINES);
  const candidate = await sampleHeap();

  // Real overflow repair, Session replacements and view detach/reattach.
  const lifecycle = await page.evaluate(async ({ rotations, views }) => {
    const harness = window.clipboardHarness.lifecycle;
    const before = harness.snapshot();
    harness.forceOverflow();
    const deadline = performance.now() + 20_000;
    while (harness.snapshot().rendererReplacements < before.rendererReplacements + 1) {
      if (performance.now() > deadline) { throw new Error('renderer overflow did not rebuild'); }
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    const afterRebuild = harness.snapshot();
    for (let index = 0; index < rotations; index += 1) {
      await harness.rotateSession();
    }
    for (let index = 0; index < views; index += 1) {
      harness.attachNewHost();
      harness.detach();
    }
    harness.attachNewHost();
    return { before, afterRebuild, afterCycles: harness.snapshot() };
  }, { rotations: SESSION_ROTATIONS, views: VIEW_CYCLES });

  const final = await sampleHeap();
  const providerCount = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const terminal = visible && visible.parentElement && visible.parentElement.xtermInstance;
    return terminal ? terminal._core._linkProviderService.linkProviders.length : -1;
  });

  const baselineMedian = median(baseline);
  const candidateMedian = median(candidate);
  const finalMedian = median(final);
  const limit = Math.max(HEAP_GROWTH_ABSOLUTE_BYTES, Math.round(baselineMedian * HEAP_GROWTH_RATIO));

  // The core claim: output past the scrollback cap does not grow retained heap
  // proportionally, and the post-repair/cycle state returns to the plateau.
  expect(
    candidateMedian - baselineMedian,
    'post-160%-output retained heap growth ' +
      bytes(candidateMedian - baselineMedian) + ' exceeds ' + bytes(limit) +
      ' (baseline samples ' + baseline.join(',') + '; candidate ' + candidate.join(',') + ')',
  ).toBeLessThanOrEqual(limit);
  expect(
    finalMedian - baselineMedian,
    'post-rebuild/cycle retained heap growth ' +
      bytes(finalMedian - baselineMedian) + ' exceeds ' + bytes(limit),
  ).toBeLessThanOrEqual(limit);

  // Retained-object counts, not only heap: the live Session holds one
  // controller and one attached host; every retired host names no Terminal;
  // no matcher provider survives.
  expect(lifecycle.afterCycles.controllersLive).toBe(1);
  expect(lifecycle.afterCycles.rendererReplacements).toBeGreaterThanOrEqual(1);
  const referencedHosts = lifecycle.afterCycles.hosts.filter((host) => host.reference !== 'none');
  expect(referencedHosts).toHaveLength(1);
  expect(referencedHosts[0].reference).toBe('live');
  expect(providerCount).toBe(1);

  const spread = (values) => Math.max(...values) - Math.min(...values);
  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': scrollback ' + scrollback + '; warm-up ' + warmup.lines +
      ' lines then ' + fill.lines + ' lines in ' + CHUNK_LINES + '-line chunks (' +
      fill.elapsedMs + ' ms) and ' + extra.lines + ' more; forced-GC heap baseline ' +
      baseline.join(',') + ' (median ' + baselineMedian + ', spread ' + spread(baseline) + '), ' +
      'candidate ' + candidate.join(',') + ' (median ' + candidateMedian + ', spread ' +
      spread(candidate) + '), final ' + final.join(',') + ' (median ' + finalMedian + ', spread ' +
      spread(final) + '); growth limit ' + limit + '; ' + SESSION_ROTATIONS +
      ' Session replacements and ' + VIEW_CYCLES + ' view cycles left live controllers=' +
      lifecycle.afterCycles.controllersLive + ', referenced hosts=' + referencedHosts.length +
      ', link providers=' + providerCount + ', renderer replacements=' +
      lifecycle.afterCycles.rendererReplacements,
  });
});
