import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePopupPortalContainer } from '@/components/ui/popup-portal';
import { AppPopupPortal } from '../../AppPopupPortal';

/**
 * The wiring #1066 turns on: which node a popup is mounted into.
 *
 * These are jsdom-measurable claims — DOM position and containment — which is
 * the whole of the mechanism. The *consequence* (a 44px row instead of 28px) is
 * a computed-geometry claim jsdom cannot make, and it is asserted in
 * `e2e/specs/ui-contract-matrix.spec.ts` against a real browser.
 */

function Menu({ label }: { label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>{label}</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem data-testid="popup-item">Row</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContainerProbe() {
  const container = usePopupPortalContainer();
  return (
    <span data-testid="probe">
      {container === null ? 'none' : container.getAttribute('data-testid')}
    </span>
  );
}

describe('AppPopupPortal — the App scope supplies a popup container', () => {
  it('renders the container on <body>, outside the App subtree, stating the scope itself', () => {
    render(
      <AppPopupPortal>
        <div data-testid="app-root" data-experience="app" />
      </AppPopupPortal>,
    );

    const host = screen.getByTestId('app-popup-portal');
    // It has to be a child of `<body>`: mounted anywhere inside the App root it
    // would sit under `overflow: hidden` (the layer root) and under a
    // `transform`ed layer (which re-parents the absolutely-positioned popup),
    // and a menu would be clipped by the element it is anchored to.
    expect(host.parentElement).toBe(document.body);
    expect(host).not.toBe(screen.getByTestId('app-root'));
    // Because it is not a descendant, it cannot inherit the scope — it has to
    // state it, and this attribute is the only reason a popup mounted here
    // resolves the App's density.
    expect(host).toHaveAttribute('data-experience', 'app');
  });

  it('publishes the container to the subtree it wraps', () => {
    render(
      <AppPopupPortal>
        <ContainerProbe />
      </AppPopupPortal>,
    );
    // Published after the host mounts, which is why the provider holds state
    // rather than a ref: base-ui reads `container` once, when the popup mounts,
    // and a node assigned later would never be read.
    expect(screen.getByTestId('probe')).toHaveTextContent('app-popup-portal');
  });

  it('mounts a menu opened inside the scope into the container', async () => {
    render(
      <AppPopupPortal>
        <Menu label="open" />
      </AppPopupPortal>,
    );
    const host = screen.getByTestId('app-popup-portal');

    await userEvent.click(screen.getByRole('button', { name: 'open' }));

    const item = await screen.findByTestId('popup-item');
    expect(host.contains(item)).toBe(true);
    // The claim the fix rests on: the popup's nearest scope ancestor is the
    // container, so `[data-experience="app"]` rules apply to it. Before #1066
    // the chain ended at `<body>` and every App menu resolved Web's density.
    expect(item.closest('[data-experience]')).toBe(host);
  });

  it('leaves a menu on <body> when no scope supplies a container — the Web case', async () => {
    render(<Menu label="open" />);

    await userEvent.click(screen.getByRole('button', { name: 'open' }));

    const item = await screen.findByTestId('popup-item');
    // Web states no floor and its popups have always resolved from `:root`, so
    // the primitive's default is not a fallback here — it is the shipped
    // behaviour, and adopting the App's container would be the failure.
    expect(item.closest('[data-experience]')).toBeNull();
    expect(screen.queryByTestId('app-popup-portal')).toBeNull();
  });
});
