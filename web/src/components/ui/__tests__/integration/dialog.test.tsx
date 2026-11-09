import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DialogFooter } from '@/components/ui/dialog';

describe('DialogFooter', () => {
  it('keeps the translucent band for a footer that stays in flow', () => {
    render(
      <DialogFooter>
        <button type="button">Save</button>
      </DialogFooter>,
    );
    const footer = screen.getByText('Save').parentElement!;
    expect(footer).not.toHaveAttribute('data-sticky');
    expect(footer.className).toContain('bg-muted/50');
    expect(footer.className).not.toContain('bg-muted ');
  });

  it('gives a sticky footer an opaque band that reaches the surface edge', () => {
    render(
      <DialogFooter sticky>
        <button type="button">Save</button>
      </DialogFooter>,
    );
    const footer = screen.getByText('Save').parentElement!;
    expect(footer).toHaveAttribute('data-sticky', 'true');
    // Opaque: fields scrolling under the band must not show through it.
    expect(footer.className).toContain('bg-muted');
    expect(footer.className).not.toContain('bg-muted/50');
    // Flush with the dialog padding edge instead of floating above it.
    expect(footer.className).toContain('-bottom-4');
  });
});
