import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityCapsule } from '@/app/workspace/CapabilityCapsule';
import type { WorkspacePresentationItem } from '@/app/workspace/presentation';

function item(
  title: string,
  state: WorkspacePresentationItem['snapshot']['state'] = 'available',
  shortTitle?: string,
): WorkspacePresentationItem {
  return {
    snapshot: {
      id: 'env',
      title,
      ...(shortTitle === undefined ? {} : { shortTitle }),
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

describe('CapabilityCapsule identity and geometry (#1455 / #1458)', () => {
  it('renders capability-owned compact identity while preserving the full accessible name', () => {
    const title = 'Environment';
    const shortTitle = 'Env';

    const { rerender } = render(
      <CapabilityCapsule
        items={[item(title, 'available', shortTitle)]}
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
    expect(label).toHaveTextContent(shortTitle);
    expect(label).not.toHaveTextContent(title);
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('whitespace-nowrap');

    rerender(
      <CapabilityCapsule
        items={[item(title, 'available', shortTitle)]}
        activeCapabilityId="env"
        onSelect={vi.fn()}
        experience="app"
      />,
    );

    expect(screen.getByTestId('workspace-tool-env').className).toContain('flex-col');
    expect(screen.getByTestId('workspace-tool-env')).toHaveAttribute('aria-label', title);
    expect(screen.getByTestId('workspace-tool-env-label')).toHaveTextContent(shortTitle);
  });

  it('expresses active selection on the entry surface without a detached dot', () => {
    const { rerender } = render(
      <CapabilityCapsule
        items={[item('Environment', 'available', 'Env')]}
        activeCapabilityId="env"
        onSelect={vi.fn()}
        experience="web"
      />,
    );

    const active = screen.getByTestId('workspace-tool-env');
    expect(active.className).toContain('bg-accent');
    expect(active.className).toContain('text-accent-foreground');
    expect(active.querySelectorAll('span')).toHaveLength(1);

    rerender(
      <CapabilityCapsule
        items={[item('Environment', 'available', 'Env')]}
        activeCapabilityId="files"
        onSelect={vi.fn()}
        experience="web"
      />,
    );

    const inactive = screen.getByTestId('workspace-tool-env');
    expect(inactive.className).toContain('bg-transparent');
    expect(inactive.className).toContain('hover:bg-muted');
    expect(inactive.querySelectorAll('span')).toHaveLength(1);
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
