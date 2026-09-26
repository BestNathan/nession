import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentContext } from '@/product/agent/patterns/AgentContext';
import type { DomainState } from '@/product/session/model/domainState';

const healthy: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};

/**
 * This component has no consumer since #748 removed the Web header that owned
 * it, so nothing else witnesses what it renders — no route, no baseline. These
 * assertions exist because the component still states a typographic role, and a
 * role nothing checks is how the mono node label comes back.
 */
describe('AgentContext', () => {
  it('sets the node name and its copy in the product face', () => {
    render(
      <AgentContext
        agentLabel="devbox-01"
        state={{ ...healthy, agent: { channel: 'offline', copy: 'Agent offline' } }}
        onOpenAgent={vi.fn()}
      />,
    );

    // #1050 stage 4: both members are the Metadata role — the node's name under
    // "Agent/location", its copy as the status detail — so neither is technical
    // and neither is monospaced.
    const chip = screen.getByTestId('agent-context');
    expect(chip.className).not.toMatch(/font-mono/);
    expect(screen.getByText('devbox-01').className).not.toMatch(/font-mono/);
    expect(screen.getByText('Agent offline').className).not.toMatch(/font-mono/);

    // The channel still owns the emphasis, which the family change must not take
    // with it.
    expect(screen.getByText('Agent offline').className).toMatch(/text-agent-offline/);
    expect(screen.getByText('devbox-01').className).toMatch(/font-medium/);
  });

  it('reports a healthy node as quiet identity and opens on click', async () => {
    const onOpenAgent = vi.fn();
    render(<AgentContext agentLabel="devbox-01" state={healthy} onOpenAgent={onOpenAgent} />);

    // Healthy is identity/context, not an achievement badge (P6): the muted name
    // and nothing beside it.
    expect(screen.getByText('devbox-01').className).toMatch(/text-muted-foreground/);
    expect(screen.queryByText(/Agent /)).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('agent-context'));
    expect(onOpenAgent).toHaveBeenCalled();
  });
});
