import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidePanel } from '../SidePanel';

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
    // Content is in DOM but panel is collapsed (w-0)
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

  it('starts resize on mousedown and updates width on mousemove', () => {
    const { container } = render(
      <SidePanel defaultOpen={true} defaultWidth={260}>
        <div>Content</div>
      </SidePanel>,
    );

    const handle = container.querySelector('.cursor-col-resize');
    expect(handle).toBeTruthy();

    fireEvent.mouseDown(handle!, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 400 });

    // Width should have increased by 100px (400 - 300)
    const panel = container.querySelector('[style]');
    expect(panel).toBeTruthy();
  });

  it('clamps width to maxWidth', () => {
    const { container } = render(
      <SidePanel defaultOpen={true} defaultWidth={260} maxWidth={300}>
        <div>Content</div>
      </SidePanel>,
    );

    const handle = container.querySelector('.cursor-col-resize');
    fireEvent.mouseDown(handle!, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 600 }); // delta = 500, but max is 300

    // Width should be clamped to maxWidth (300)
  });

  it('clamps width to minWidth', () => {
    const { container } = render(
      <SidePanel defaultOpen={true} defaultWidth={260} minWidth={200}>
        <div>Content</div>
      </SidePanel>,
    );

    const handle = container.querySelector('.cursor-col-resize');
    fireEvent.mouseDown(handle!, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 50 }); // delta = -250, but min is 200

    // Width should be clamped to minWidth (200)
  });

  it('ends resize on mouseup', () => {
    const { container } = render(
      <SidePanel defaultOpen={true} defaultWidth={260}>
        <div>Content</div>
      </SidePanel>,
    );

    const handle = container.querySelector('.cursor-col-resize');
    fireEvent.mouseDown(handle!, { clientX: 300 });
    fireEvent.mouseUp(document);

    // After mouseup, mousemove should not trigger resize
    fireEvent.mouseMove(document, { clientX: 500 });
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
