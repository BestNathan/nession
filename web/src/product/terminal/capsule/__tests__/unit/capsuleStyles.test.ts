import { describe, expect, it } from 'vitest';
import {
  capsuleIconButtonClass,
  capsuleIconVisualClass,
  capsulePhysKeyButtonClass,
  capsulePhysKeyGridGapClass,
  capsulePhysKeyIconClass,
  capsulePhysKeyRowClass,
  capsulePopoverPanelClass,
  capsuleProjectionClass,
  contextCapsuleReasonClass,
  contextCapsuleSurfaceClass,
  contextCapsuleTitleClass,
} from '@/product/terminal/capsule/capsuleStyles';

describe('capsuleStyles', () => {
  it('rounds the projection with its own token, not a generic radius', () => {
    // `#1110`. The projection borrowed `var(--radius-lg)` — which resolves to
    // `var(--radius)`, the generic shadcn-scale value a menu or a card also
    // uses — so the corner was the one part of the surface the surface did not
    // own, and `terminalCapsule.projectionRadius` was read by nothing.
    //
    // **Asserted on the token name, not on a pixel value.** The two resolve to
    // 10px and 12px today, so a `toContain('12px')`-shaped check would pass on
    // the wrong one the moment the values converged — and a rendered-value
    // assertion in the browser would pass on *both* if they ever agreed. The
    // question is which token the class names, so that is what is asked.
    expect(capsuleProjectionClass).toContain(
      'rounded-[var(--terminal-capsule-projection-radius)]',
    );
    expect(capsuleProjectionClass).not.toContain('--radius-lg');
  });

  it('caps the token-sized popover to the viewport inset', () => {
    expect(capsulePopoverPanelClass).toContain('w-[length:var(--terminal-capsule-popover-width)]');
    expect(capsulePopoverPanelClass).toContain(
      'max-w-[calc(100vw-var(--terminal-capsule-popover-viewport-inset))]',
    );
    expect(capsulePopoverPanelClass).toContain('var(--terminal-capsule-popover-zindex)');
  });

  it('provides the shared physical-key grid gap token', () => {
    expect(capsulePhysKeyGridGapClass).toContain('var(--terminal-capsule-phys-key-grid-gap)');
  });

  it('keeps physical-key labels on a five-character touch target', () => {
    expect(capsulePhysKeyButtonClass).toContain('min-w-[5ch]');
    expect(capsulePhysKeyButtonClass).toContain('whitespace-nowrap');
  });

  it('uses compact horizontal physical-key layout tokens', () => {
    expect(capsulePhysKeyRowClass).toContain('flex-row');
    expect(capsulePhysKeyRowClass).toContain('items-center');
    expect(capsulePhysKeyButtonClass).toContain(
      'text-[length:var(--terminal-capsule-phys-key-font-size)]',
    );
    expect(capsulePhysKeyIconClass).toContain(
      'var(--terminal-capsule-phys-key-icon-size)',
    );
  });

  // #1034: the hit target and the drawn affordance are two axes on two elements.
  // On App `control.sm` and `control.md` are both 44px, so the *token a class
  // names* is the only thing that can tell a 44px control apart from a 36px
  // circle — asserting the px would pass either way.
  it('keeps the hit target on control.md and the drawn affordance on control.visualSize', () => {
    expect(capsuleIconButtonClass).toContain('var(--control-md)');
    expect(capsuleIconVisualClass).toContain('var(--control-visual-size)');
    expect(capsuleIconButtonClass).not.toContain('control-sm');
    expect(capsuleIconVisualClass).not.toContain('control-sm');
  });

  it('carries no hit area on the drawn affordance and no paint on the hit target', () => {
    // The split is only real if each class owns one axis: a size on the visual
    // would be a second hit area, and a background on the control would fill the
    // 44px box on hover/touch and paint over the smaller circle.
    expect(capsuleIconVisualClass).toContain('size-[length:var(--control-visual-size)]');
    expect(capsuleIconVisualClass).toContain('rounded-full');
    expect(capsuleIconVisualClass).not.toContain('var(--control-md)');
    expect(capsuleIconButtonClass).not.toMatch(/\bbg-/);
    expect(capsuleIconButtonClass).not.toMatch(/hover:bg-/);
  });

  it('ceils the Context Capsule rather than fixing its height', () => {
    // **Asserted on the token name, for the reason above.** The question this
    // answers is *which* constraint the surface declares — `max-h-` on the
    // ceiling token, or `h-` on a height — and a rendered-value assertion cannot
    // tell them apart in the case that matters: when the content is taller than
    // the ceiling both resolve to the ceiling, so a pixel check would pass on a
    // `height` that had quietly come back. The measured half of this claim (a
    // short list is *shorter* than the ceiling, and all three sense states agree)
    // is in `e2e/specs/ui-contract-matrix.spec.ts`, where it can be measured.
    expect(contextCapsuleSurfaceClass).toContain(
      'max-h-[length:var(--context-capsule-max-height)]',
    );
    expect(contextCapsuleSurfaceClass).not.toContain('--context-capsule-height');
  });

  it('sets both row lines in the design language roles, not the capsule font size', () => {
    // Measured on staging 2026-10-04: every line in the row was 16px — the
    // title and the reason were the same size, distinguished only by colour —
    // because both classes refed `terminalCapsule.fontSize` /
    // `captionFontSize`, and both of those resolve to `primitive.typography`.
    // The design language has a ramp for exactly this job; `body`'s own note
    // names "button labels, menu items, filters".
    for (const cls of [contextCapsuleTitleClass, contextCapsuleReasonClass]) {
      expect(cls).toContain('--typography-');
      expect(cls).not.toContain('--terminal-capsule-');
    }
    expect(contextCapsuleTitleClass).toContain('var(--typography-body-size)');
    expect(contextCapsuleTitleClass).toContain('var(--typography-body-weight)');
    expect(contextCapsuleReasonClass).toContain('var(--typography-caption-size)');
    expect(contextCapsuleReasonClass).toContain('var(--typography-caption-weight)');
  });

  it('keeps the two lines inside one row band without a capsule leading token', () => {
    // 14 * 1.4 + 11.5 * 1.3 = 34.55px on App, 13 * 1.35 + 11 * 1.3 = 31.85px on
    // Web, against a 44px band. The role leadings are what make the band hold,
    // so a capsule-local leading would be a second answer to the same question.
    expect(contextCapsuleTitleClass).not.toContain('--context-capsule-row-line-height');
    expect(contextCapsuleReasonClass).not.toContain('--context-capsule-row-line-height');
  });
});
