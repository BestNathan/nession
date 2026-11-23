import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkspaceBoundedScrollport } from '@/components/ui/workspace-scrollport';
import {
  WORKSPACE_BOUNDED_SCROLL_MARKER,
  workspaceBoundedScrollClearanceClass,
} from '@/shared/lib/workspaceScrollClearance';

/**
 * The bounded scrollport's whole point (#4222 SC-01): caller content spacing
 * lives inside the viewport, so a `p-2`/`pb-6`/`py-3` cannot override the
 * host-measured bottom inset by winning Tailwind's merge on the scroll element.
 */
describe('WorkspaceBoundedScrollport', () => {
  it('keeps content spacing off the scrolling viewport', () => {
    render(
      <WorkspaceBoundedScrollport
        data-testid="scrollport"
        viewportClassName="h-full"
        className="p-2 pb-6"
      >
        <p>row</p>
      </WorkspaceBoundedScrollport>,
    );

    const viewport = screen.getByTestId('scrollport');
    const content = viewport.querySelector('[data-workspace-scrollport-content]');

    expect(viewport.getAttribute('data-workspace-scrollport')).toBe('bounded');
    expect(viewport.className).toContain(WORKSPACE_BOUNDED_SCROLL_MARKER);
    expect(viewport.className).toContain(workspaceBoundedScrollClearanceClass);
    expect(viewport.className).not.toMatch(/\bp-2\b/);
    expect(viewport.className).not.toMatch(/\bpb-6\b/);

    expect(content).not.toBeNull();
    expect(content?.className).toContain('p-2');
    expect(content?.className).toContain('pb-6');
  });

  it('applies the measured clearance after caller viewport classes', () => {
    render(
      <WorkspaceBoundedScrollport
        data-testid="scrollport"
        viewportClassName="p-4 pb-3"
      >
        row
      </WorkspaceBoundedScrollport>,
    );

    const viewport = screen.getByTestId('scrollport');
    // Tailwind merge keeps the latter `pb` when two conflict; the clearance is
    // appended last, so a caller band can never be the final bottom padding.
    const clearanceAt = viewport.className.indexOf(
      'pb-[var(--nession-local-workspace-scroll-bottom-inset,0px)]',
    );
    expect(clearanceAt).toBeGreaterThan(-1);
    expect(viewport.className.slice(clearanceAt)).toContain('pb-[var(');
    // No content classes means no extra box: layout-sensitive readers (a
    // CodeMirror host, a virtualized body) keep rendering directly in the
    // viewport exactly as before the recipe.
    expect(viewport.querySelector('[data-workspace-scrollport-content]')).toBeNull();
  });
});
