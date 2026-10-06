import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityCapsule } from '@/app/workspace/CapabilityCapsule';
import type { WorkspacePresentationItem } from '@/app/workspace/presentation';

function item(
  title: string,
  state: WorkspacePresentationItem['snapshot']['state'] = 'available',
): WorkspacePresentationItem {
  return {
    snapshot: {
      id: 'env',
      title,
      state,
      scope: { sessionId: 'agent-1:work' },
    },
    presence: {
      capabilityId: 'env',
      surface: 'workspace',
      level: state === 'unavailable' ? 'hidden' : 'discoverable',
    },
  };
}

describe('CapabilityCapsule geometry (#1455)', () => {
  it('contains a long label inside one fixed control band and preserves its full accessible name', () => {
    const title =
      'Environment Configuration and Runtime Diagnostics with a Deliberately Long Name';

    const { rerender } = render(
      <CapabilityCapsule
        items={[item(title)]}
        activeCapabilityId="env"
        onSelect={vi.fn()}
        experience="web"
      />,
    );

    const entry = screen.getByTestId('workspace-tool-env');
    const label = screen.getByTestId('workspace-tool-env-label');

    expect(entry.className).toContain('h-[length:var(--nession-control-md)]');
    expect(entry.className).toContain('flex-row');
    expect(entry.getAttribute('style')).toBeNull();
    expect(entry).toHaveAttribute('aria-label', title);
    expect(entry).toHaveAttribute('title', title);
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('whitespace-nowrap');

    rerender(
      <CapabilityCapsule
        items={[item(title)]}
        activeCapabilityId="env"
        onSelect={vi.fn()}
        experience="app"
      />,
    );

    expect(screen.getByTestId('workspace-tool-env').className).toContain('flex-col');
    expect(screen.getByTestId('workspace-tool-env')).toHaveAttribute('aria-label', title);
  });

  it('defensively refuses to render unavailable capability chrome', () => {
    render(
      <CapabilityCapsule
        items={[item('Environment', 'unavailable')]}
        activeCapabilityId="env"
        onSelect={vi.fn()}
        experience="web"
      />,
    );

    expect(screen.queryByTestId('workspace-tool-env')).not.toBeInTheDocument();
  });
});
