// Reusable browser-level UI assertions (#546). Every check measures computed
// layout/DOM geometry — never screenshots — and throws a structured
// UI_CONTRACT_VIOLATION an AI repair loop can consume:
//
//   pattern / rule / experience / viewport / expected / actual / measured
//
// Expectations come from design/contracts (#545) unless a test explicitly
// overrides a field for a broken-fixture proof.
import type { Locator } from '@playwright/test';
import type { ContractBlock, Experience } from './contracts';
import { contractFor } from './contracts';

export interface AssertOptions {
  pattern: string;
  experience: Experience;
  /** Matrix/viewport id (validation.md, #547); informational until the matrix lands. */
  viewport?: string;
  /** Per-call contract override — broken-fixture proofs only. */
  contract?: Partial<ContractBlock>;
  /** Height tolerance in px (default 1 — borders/antialiasing). */
  tolerance?: number;
}

export interface ViolationFields {
  pattern: string;
  rule: string;
  experience: Experience;
  viewport?: string;
  expected: string;
  actual: string;
  measured?: string;
}

export class UiContractViolation extends Error {
  readonly fields: ViolationFields;

  constructor(fields: ViolationFields) {
    super(formatViolation(fields));
    this.name = 'UiContractViolation';
    this.fields = fields;
  }
}

export function formatViolation(f: ViolationFields): string {
  const lines = [
    'UI_CONTRACT_VIOLATION',
    `pattern: ${f.pattern}`,
    `rule: ${f.rule}`,
    `experience: ${f.experience}`,
  ];
  if (f.viewport !== undefined) lines.push(`viewport: ${f.viewport}`);
  lines.push(`expected: ${f.expected}`, `actual: ${f.actual}`);
  if (f.measured !== undefined) lines.push(`measured: ${f.measured}`);
  return lines.join('\n');
}

function violation(opts: AssertOptions, rule: string, expected: string, actual: string, measured?: string): never {
  throw new UiContractViolation({
    pattern: opts.pattern,
    rule,
    experience: opts.experience,
    viewport: opts.viewport,
    expected,
    actual,
    measured,
  });
}

function blockFor(opts: AssertOptions): ContractBlock {
  return contractFor(opts.pattern, opts.experience, opts.contract);
}

interface BoxMetrics {
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  textRows: number;
  overflowY: string;
}

async function measure(el: Locator): Promise<BoxMetrics> {
  return el.evaluate((node: Element) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const lineHeight = Number.parseFloat(style.lineHeight) || 0;

    // Distinct horizontal text rows: group the top edges of every visible
    // text leaf rect into line buckets sized by the line-height.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const tops: number[] = [];
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (text.data.trim().length === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const rect2 = range.getBoundingClientRect();
      if (rect2.width > 0 && rect2.height > 0) tops.push(rect2.top);
    }
    const buckets = new Set<number>();
    const step = lineHeight > 0 ? lineHeight : 16;
    for (const top of tops) buckets.add(Math.round(top / step));

    return {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      scrollWidth: node.scrollWidth,
      scrollHeight: node.scrollHeight,
      clientWidth: node.clientWidth,
      clientHeight: node.clientHeight,
      textRows: tops.length === 0 ? 1 : buckets.size,
      overflowY: style.overflowY,
    };
  });
}

function diffTolerance(a: number, b: number, tolerance: number): number {
  return Math.abs(a - b) - tolerance;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** The element must behave as one line: its text occupies a single row. */
export async function expectSingleLine(locator: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  if (block.wrap !== false) return; // contract does not force single-line
  const { textRows } = await measure(locator);
  if (textRows !== 1) {
    violation(opts, 'single-line', '1 line', `${textRows} lines`, undefined);
  }
}

/** Measured element height must match the contract's heightToken (± tolerance). */
export async function expectTokenHeight(locator: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  if (block.heightTokenPx === undefined) return; // pattern height not pinned by a token
  const { height } = await measure(locator);
  const delta = diffTolerance(height, block.heightTokenPx, opts.tolerance ?? 1);
  if (delta > 0) {
    violation(
      opts,
      'height',
      `${block.heightToken} (${block.heightTokenPx}px)`,
      `${height.toFixed(1)}px`,
      `measuredHeight: ${height.toFixed(1)}px`,
    );
  }
}

/**
 * Content must not overflow the element's own bounds beyond the contract's
 * overflow strategy. `clip` = no measurable overflow; `scroll` = the element
 * itself is the scroll owner (vertical scroll allowed, horizontal must not).
 */
export async function expectNoUnexpectedOverflow(locator: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  if (block.overflow === 'wrap') return; // wrapping IS the overflow strategy
  const m = await measure(locator);
  const overflowX = m.scrollWidth - m.clientWidth;
  const overflowY = m.scrollHeight - m.clientHeight;
  const scrollsY = block.overflow === 'scroll' && (block.scrollOwner === true || block.scrollOwner === 'self');

  if (overflowX > 1) {
    violation(opts, 'overflow', `no horizontal overflow (strategy: ${block.overflow})`, `${overflowX}px`, `overflowX: ${overflowX}px`);
  }
  if (overflowY > 1 && !scrollsY) {
    violation(opts, 'overflow', `no vertical overflow (strategy: ${block.overflow})`, `${overflowY}px`, `overflowY: ${overflowY}px`);
  }
}

/** App-density hit area: both dimensions ≥ touchTargetToken. */
export async function expectTouchTarget(locator: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  if (block.touchTargetTokenPx === undefined) return;
  const { width, height } = await measure(locator);
  if (width < block.touchTargetTokenPx - (opts.tolerance ?? 0) || height < block.touchTargetTokenPx - (opts.tolerance ?? 0)) {
    violation(
      opts,
      'touch-target',
      `${block.touchTargetToken} (${block.touchTargetTokenPx}px)`,
      `${Math.min(width, height).toFixed(1)}px (${width.toFixed(1)}×${height.toFixed(1)})`,
      undefined,
    );
  }
}

/** Target must be fully visible within a named container. */
export async function expectVisibleWithin(
  target: Locator,
  container: Locator,
  opts: AssertOptions,
): Promise<void> {
  const [t, c] = await Promise.all([measure(target), measure(container)]);
  if (t.top < c.top - 0.5 || t.bottom > c.bottom + 0.5 || t.left < c.left - 0.5 || t.right > c.right + 0.5) {
    violation(
      opts,
      'visibility',
      `fully inside container (${c.width.toFixed(1)}×${c.height.toFixed(1)})`,
      `target ${t.width.toFixed(1)}×${t.height.toFixed(1)} at (${t.left.toFixed(1)},${t.top.toFixed(1)})`,
      undefined,
    );
  }
}

/** Cross-axis alignment intent: vertical centers match within 1px. */
export async function expectAlignedY(
  targets: Locator[],
  container: Locator,
  opts: AssertOptions,
): Promise<void> {
  const block = blockFor(opts);
  if (block.alignY !== 'middle') return;
  const c = await measure(container);
  const center = (c.top + c.bottom) / 2;
  for (const target of targets) {
    const t = await measure(target);
    const targetCenter = (t.top + t.bottom) / 2;
    if (Math.abs(targetCenter - center) > 1.5) {
      violation(opts, 'align-y', `center-aligned to container`, `${(targetCenter - center).toFixed(1)}px off`, undefined);
    }
  }
}

/** The named scroll owner must actually scroll its content when it overflows. */
export async function expectScrollable(locator: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  const owns = block.scrollOwner === true || block.scrollOwner === 'self';
  if (!owns) return;
  const m = await measure(locator);
  const contentOverflows = m.scrollHeight > m.clientHeight + 1;
  if (!contentOverflows) return; // nothing to scroll — still fine
  const canScroll = m.overflowY === 'auto' || m.overflowY === 'scroll' || m.overflowY === 'overlay';
  if (!canScroll) {
    violation(
      opts,
      'scroll-owner',
      'scrollable region (overflow-y auto/scroll)',
      `overflow-y: ${m.overflowY}`,
      `overflowY: ${m.overflowY}`,
    );
  }
}
