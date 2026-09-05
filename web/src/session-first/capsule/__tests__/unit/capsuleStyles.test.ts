import { describe, expect, it } from 'vitest';
import {
  capsulePhysKeyGridGapClass,
  capsulePopoverPanelClass,
} from '@/session-first/capsule/capsuleStyles';

describe('capsuleStyles', () => {
  it('caps the token-sized popover to the viewport inset', () => {
    expect(capsulePopoverPanelClass).toContain('w-[length:var(--composer-popover-width)]');
    expect(capsulePopoverPanelClass).toContain(
      'max-w-[calc(100vw-var(--composer-popover-viewport-inset))]',
    );
  });

  it('provides the shared physical-key grid gap token', () => {
    expect(capsulePhysKeyGridGapClass).toContain('var(--composer-phys-key-grid-gap)');
  });
});
