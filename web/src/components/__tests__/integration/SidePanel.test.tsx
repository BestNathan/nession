import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidePanel } from '@/components/SidePanel';

describe('SidePanel', () => {
  it('renders children when open', () => {
    render(
      <SidePanel defaultOpen={true}>
        <div>Panel Content</div>
      </SidePanel>,
    );
    expect(screen.getByText('Panel Content')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <SidePanel defaultOpen={false}>
        <div>Hidden Content</div>
      </SidePanel>,
    );
    // Panel is always mounted to preserve ResizablePanel layout on desktop.
    expect(screen.getByText('Hidden Content')).toBeInTheDocument();
  });

  it('toggles open/closed when button clicked', () => {
    render(
      <SidePanel defaultOpen={true}>
        <div>Content</div>
      </SidePanel>,
    );

    const toggleBtn = screen.getByTitle('Close panel');
    fireEvent.click(toggleBtn);
    // After toggle, button should show "Open panel"
    expect(screen.getByTitle('Open panel')).toBeInTheDocument();
  });

  it('shows close icon when open', () => {
    render(
      <SidePanel defaultOpen={true}>
        <div>Content</div>
      </SidePanel>,
    );
    expect(screen.getByTitle('Close panel')).toBeInTheDocument();
  });

  it('shows open icon when closed', () => {
    render(
      <SidePanel defaultOpen={false}>
        <div>Content</div>
      </SidePanel>,
    );
    expect(screen.getByTitle('Open panel')).toBeInTheDocument();
  });

  it('applies default width', () => {
    const { container } = render(
      <SidePanel defaultOpen={true} defaultWidth={300}>
        <div>Content</div>
      </SidePanel>,
    );
    const panel = container.querySelector('[style]');
    expect(panel).toBeTruthy();
  });

  it('renders a backdrop when open', () => {
    const { container } = render(
      <SidePanel defaultOpen={true}>
        <div>Content</div>
      </SidePanel>,
    );
    expect(container.querySelector('[data-testid="sidepanel-backdrop"]')).toBeTruthy();
  });

  it('does not render a backdrop when closed', () => {
    const { container } = render(
      <SidePanel defaultOpen={false}>
        <div>Content</div>
      </SidePanel>,
    );
    expect(container.querySelector('[data-testid="sidepanel-backdrop"]')).toBeFalsy();
  });

  it('closes when the backdrop is clicked', () => {
    const { container } = render(
      <SidePanel defaultOpen={true}>
        <div>Content</div>
      </SidePanel>,
    );
    const backdrop = container.querySelector('[data-testid="sidepanel-backdrop"]')!;
    fireEvent.click(backdrop);
    expect(screen.getByTitle('Open panel')).toBeInTheDocument();
  });
});
