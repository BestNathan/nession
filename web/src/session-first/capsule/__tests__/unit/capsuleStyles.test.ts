import { describe, expect, it } from 'vitest';
import {
  capsuleCommandsDismissLayerClass,
  capsuleCommandsOverlayPanelClass,
  capsulePhysKeyButtonClass,
  capsulePhysKeyGridGapClass,
  capsulePhysKeyIconClass,
  capsulePhysKeyRowClass,
  capsulePopoverPanelClass,
} from '@/session-first/capsule/capsuleStyles';

describe('capsuleStyles', () => {
  it('caps the token-sized popover to the viewport inset', () => {
    expect(capsulePopoverPanelClass).toContain('w-[length:var(--composer-popover-width)]');
    expect(capsulePopoverPanelClass).toContain(
      'max-w-[calc(100vw-var(--composer-popover-viewport-inset))]',
    );
    expect(capsulePopoverPanelClass).toContain('var(--composer-popover-zindex)');
  });

  it('provides the shared physical-key grid gap token', () => {
    expect(capsulePhysKeyGridGapClass).toContain('var(--composer-phys-key-grid-gap)');
  });

  it('keeps physical-key labels on a five-character touch target', () => {
    expect(capsulePhysKeyButtonClass).toContain('min-w-[5ch]');
    expect(capsulePhysKeyButtonClass).toContain('whitespace-nowrap');
  });

  it('uses compact horizontal physical-key layout tokens', () => {
    expect(capsulePhysKeyRowClass).toContain('flex-row');
    expect(capsulePhysKeyRowClass).toContain('items-center');
    expect(capsulePhysKeyButtonClass).toContain(
      'text-[length:var(--composer-phys-key-font-size)]',
    );
    expect(capsulePhysKeyIconClass).toContain(
      'var(--composer-phys-key-icon-size)',
    );
  });

  it('overlay panel is absolutely positioned over the terminal host', () => {
    expect(capsuleCommandsOverlayPanelClass).toContain('absolute');
    expect(capsuleCommandsOverlayPanelClass).toContain('z-[15]');
  });

  it('dismiss layer sits below capsule dock z-index', () => {
    expect(capsuleCommandsDismissLayerClass).toContain('z-10');
  });
});
