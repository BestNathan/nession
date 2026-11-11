import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_LAYOUT,
  WorkspaceMasterDetail,
  WorkspaceScrollRegion,
} from '@/app/workspace/layout/workspaceLayout';

describe('Workspace layout recipes (#3194)', () => {
  it('owns the master/detail geometry and renders both regions', () => {
    render(
      <WorkspaceMasterDetail data-testid="layout" navigation={<nav>tree</nav>}>
        <p>detail</p>
      </WorkspaceMasterDetail>,
    );

    const layout = screen.getByTestId('layout');
    expect(layout).toHaveAttribute('data-workspace-layout', 'master-detail');
    expect(layout.className).toContain('overflow-hidden');
    expect(layout.querySelector('[data-workspace-layout-part="navigation"]')).not.toBeNull();
    expect(layout.querySelector('[data-workspace-layout-part="content"]')).not.toBeNull();
    expect(screen.getByText('tree')).toBeVisible();
    expect(screen.getByText('detail')).toBeVisible();
  });

  it('owns the single scroll region and its Capsule clearance', () => {
    render(
      <WorkspaceScrollRegion data-testid="scroll">
        <p>content</p>
      </WorkspaceScrollRegion>,
    );

    const scroll = screen.getByTestId('scroll');
    expect(scroll).toHaveAttribute('data-workspace-scroll-owner', 'true');
    expect(scroll.className).toContain('overflow-y-auto');
    expect(scroll.className).toContain('--nession-local-workspace-content-bottom-inset');
  });

  it('keeps the recipe marker names stable for the design Gate and browser Case', () => {
    expect(WORKSPACE_LAYOUT.scrollOwner).toBe('data-workspace-scroll-owner');
    expect(WORKSPACE_LAYOUT.masterDetail).toBe('master-detail');
  });
});
