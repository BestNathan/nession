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
});
