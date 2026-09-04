import { describe, expect, it } from 'vitest';
import {
  capsulePhysKeyOverflowClass,
  capsulePhysKeyScrollClass,
  capsulePopoverPanelClass,
} from '@/session-first/capsule/capsuleStyles';

describe('capsuleStyles', () => {
  it('caps the token-sized popover to the viewport inset', () => {
    expect(capsulePopoverPanelClass).toContain('w-[length:var(--composer-popover-width)]');
    expect(capsulePopoverPanelClass).toContain(
      'max-w-[calc(100vw-var(--composer-popover-viewport-inset))]',
    );
  });

  it('provides compact horizontally scrolling physical-key row classes', () => {
    expect(capsulePhysKeyScrollClass).toBe(
      'flex min-w-0 flex-1 items-center gap-[length:var(--composer-phys-key-grid-gap)] overflow-x-auto scrollbar-none',
    );
    expect(capsulePhysKeyOverflowClass).toBe('shrink-0');
  });
});
