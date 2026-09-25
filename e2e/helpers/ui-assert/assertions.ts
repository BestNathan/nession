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

/** Computed horizontal padding must match the contract's padXToken (± tolerance). */
export async function expectPaddingX(locator: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  if (block.padXTokenPx === undefined) return;
  const paddingLeft = await locator.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).paddingLeft),
  );
  const delta = diffTolerance(paddingLeft, block.padXTokenPx, opts.tolerance ?? 1);
  if (delta > 0) {
    violation(
      opts,
      'pad-x',
      `${block.padXToken} (${block.padXTokenPx}px)`,
      `${paddingLeft.toFixed(1)}px`,
      `computedPaddingLeft: ${paddingLeft.toFixed(1)}px`,
    );
  }
}

/** Computed max-width must match the contract's maxWidthToken (± tolerance). */
export async function expectMaxWidth(locator: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  if (block.maxWidthTokenPx === undefined) return;
  const maxWidth = await locator.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).maxWidth),
  );
  // `max-width: none` parses to NaN — an unbounded surface where the contract
  // says the width is bounded. Treat it as a violation, not as "no measurement".
  const bounded = Number.isFinite(maxWidth);
  const actual = bounded ? `${maxWidth.toFixed(1)}px` : 'none';
  if (!bounded || diffTolerance(maxWidth, block.maxWidthTokenPx, opts.tolerance ?? 1) > 0) {
    violation(
      opts,
      'max-width',
      `${block.maxWidthToken} (${block.maxWidthTokenPx}px)`,
      actual,
      `computedMaxWidth: ${actual}`,
    );
  }
}

/**
 * Corner radius must be the contract's radiusToken.
 *
 * The token is `calc(var(--radius) * 2.2)`, so there is no px to compare — the
 * assertion builds a probe element from the resolved expression and compares
 * computed radii, letting the browser do the arithmetic. The probe is appended
 * to the page under test, so it resolves `var(--radius)` exactly as the pattern
 * does.
 *
 * What this does **not** catch on its own: a hard-coded radius whose resolved
 * value happens to equal the token's. That side is covered by
 * `nession/no-capsule-magic-metrics`, which forbids arbitrary numeric
 * dimensions on the capsule path — together they pin both name and value.
 */
export async function expectRadius(locator: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  // The capsule ships two shapes and switches between them on
  // `data-shell-shape` (CapsuleShell.tsx). Asserting one radius unconditionally
  // would be wrong half the time, so the element's own shape picks the token.
  //
  // The attribute is on the *root* (`terminal-capsule`), while the radius class
  // is on the inner `capsule-shell` — so read it from the nearest ancestor that
  // carries it rather than from the element itself, which would always be null
  // and silently assert the non-pill token.
  const shape = await locator.evaluate((el) =>
    el.closest('[data-shell-shape]')?.getAttribute('data-shell-shape') ?? null,
  );
  const isPill = shape === 'pill';
  const css = isPill ? block.pillRadiusTokenCss : block.radiusTokenCss;
  const token = isPill ? block.pillRadiusToken : block.radiusToken;
  if (css === undefined) return;
  const actual = await locator.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  const expected = await locator.evaluate((el, value) => {
    const probe = el.ownerDocument.createElement('div');
    probe.style.position = 'absolute';
    probe.style.borderRadius = value;
    el.ownerDocument.body.appendChild(probe);
    const resolved = getComputedStyle(probe).borderTopLeftRadius;
    probe.remove();
    return resolved;
  }, css);
  if (actual !== expected) {
    violation(
      opts,
      'radius',
      `${token} (${css} → ${expected}) for shape "${shape ?? 'capsule'}"`,
      actual,
      `computedBorderTopLeftRadius: ${actual}`,
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

/**
 * The affordance a control *draws* must be the contract's `visualSizeToken`,
 * sized to it, and inside the control that receives the tap (#1034).
 *
 * Why a second assertion is needed at all: `expectTokenHeight` and
 * `expectTouchTarget` both measure the element they are handed, so both stop at
 * the control's outer box. A 44px tap target painted with a 36px circle *is* a
 * correct 44px control to them — and on App, where `control.sm` and `control.md`
 * are both 44px, no measurement of the outer box can tell that drawing apart
 * from one that grew back to fill it. The difference lives on a second node, so
 * proving it takes a helper that reaches for one. That node is the contract's,
 * not this helper's: `capsule-control-visual` is shipped by
 * `CapsuleIconVisual`, and its size comes from `visualSizeTokenPx` — per
 * experience, so one call covers Web (32px, equal to Web's own band by
 * construction) and App (36px inside a 44px target) without the spec knowing
 * which experience it is running.
 */
export async function expectDrawnAffordance(control: Locator, opts: AssertOptions): Promise<void> {
  const block = blockFor(opts);
  if (block.visualSizeTokenPx === undefined) return; // pattern pins no drawn affordance

  const visuals = control.locator('[data-testid="capsule-control-visual"]');
  const count = await visuals.count();
  if (count !== 1) {
    violation(
      opts,
      'drawn-affordance',
      'exactly one drawn affordance inside the control',
      `${count} found`,
      'testid: capsule-control-visual',
    );
  }

  const tolerance = opts.tolerance ?? 1;
  const [c, v] = await Promise.all([measure(control), measure(visuals.first())]);

  const sizeDelta = Math.max(
    diffTolerance(v.width, block.visualSizeTokenPx, tolerance),
    diffTolerance(v.height, block.visualSizeTokenPx, tolerance),
  );
  if (sizeDelta > 0) {
    violation(
      opts,
      'drawn-affordance',
      `${block.visualSizeToken} (${block.visualSizeTokenPx}px)`,
      `${v.width.toFixed(1)}×${v.height.toFixed(1)}px`,
      `measuredVisual: ${v.width.toFixed(1)}×${v.height.toFixed(1)}px`,
    );
  }

  // It must be drawn *within* the control, not over or beside it. Containment,
  // not inequality: on Web the two are equal by construction, so requiring a
  // strict margin here would fail a contract that is deliberately a no-op there.
  const escaped =
    v.left < c.left - tolerance ||
    v.right > c.right + tolerance ||
    v.top < c.top - tolerance ||
    v.bottom > c.bottom + tolerance;
  if (escaped) {
    violation(
      opts,
      'drawn-affordance',
      'drawn affordance contained by its control',
      `visual ${v.width.toFixed(1)}×${v.height.toFixed(1)} at (${v.left.toFixed(1)},${v.top.toFixed(1)})`,
      `control ${c.width.toFixed(1)}×${c.height.toFixed(1)} at (${c.left.toFixed(1)},${c.top.toFixed(1)})`,
    );
  }

  // Where the contract says the painted affordance is smaller than the band, the
  // rendered box must actually be smaller — this is the #1034 invariant itself.
  // Conditional because Web's `control.visualSize` equals its `control.md`: the
  // band check above is what pins the size there, and requiring a margin would
  // fail the experience the contract deliberately left unchanged.
  if (
    block.heightTokenPx !== undefined &&
    block.visualSizeTokenPx < block.heightTokenPx &&
    (v.width >= c.width - tolerance || v.height >= c.height - tolerance)
  ) {
    violation(
      opts,
      'drawn-affordance',
      `drawn affordance smaller than its ${block.heightToken} band (${block.heightTokenPx}px)`,
      `${v.width.toFixed(1)}×${v.height.toFixed(1)}px inside ${c.width.toFixed(1)}×${c.height.toFixed(1)}px`,
      `measuredVisual: ${v.width.toFixed(1)}×${v.height.toFixed(1)}px`,
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
