import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChoiceItemContent } from '@/components/ui/choice-item';
import { resourceChoiceItemClass } from '@/components/ui/choice-itemStyles';
import { popupMenuItemBandClass } from '@/components/ui/overlayStyles';

describe('ChoiceItemContent', () => {
  it('renders the resource slot grammar in hierarchy order', () => {
    render(
      <ChoiceItemContent
        title="devbox-01"
        meta="Remote compute"
        detail="/srv/nession/services/web"
        detailTestId="choice-path"
        status="Online"
        statusTestId="choice-status"
      />,
    );

    expect(screen.getByText('devbox-01')).toHaveAttribute('data-slot', 'choice-item-title');
    expect(screen.getByText('Remote compute')).toHaveAttribute('data-slot', 'choice-item-meta');
    expect(screen.getByTestId('choice-path')).toHaveTextContent('/srv/nession/services/web');
    expect(screen.getByTestId('choice-path').className).toContain('break-all');
    expect(screen.getByTestId('choice-status')).toHaveTextContent('Online');
    expect(screen.getByTestId('choice-status').className).toContain('text-muted-foreground');
  });

  it('marks an unavailable status with the destructive role', () => {
    render(<ChoiceItemContent title="sg-prod" status="Offline" statusTone="unavailable" />);
    expect(screen.getByText('Offline').className).toContain('text-destructive');
  });

  it('keeps the experience control band as the resource row minimum', () => {
    // The 28px Web / 44px App action band is the floor for both anatomies;
    // a resource row may only grow from it (issue 3164).
    expect(popupMenuItemBandClass).toContain('min-h-[length:var(--nession-control-sm)]');
    expect(resourceChoiceItemClass).toContain('min-h-[length:var(--nession-control-sm)]');
    expect(resourceChoiceItemClass).not.toMatch(/(?:^|\s)h-\d/);
    expect(resourceChoiceItemClass).toContain('data-[selected]:bg-muted/60');
    expect(resourceChoiceItemClass).toContain('focus:bg-accent');
  });
});
