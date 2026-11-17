import { Plug } from 'lucide-react';

import type { WorkspaceViewBinding } from '@/app/workspace/workspaceContext';
import { FixtureMcpUiKit } from './FixtureMcpUiKit';

export const MCP_KIT_FIXTURE_VIEW_ID = 'mcp-kit';

/**
 * Fixture-only Workspace view binding.
 *
 * It is not a product capability: there is no provider for `mcp-kit`, so it
 * never gains a capsule slot. The fixture composer passes this binding to the
 * real WorkspaceShell, which is what lets the browser Case review the kit
 * inside the actual Workspace chrome without shipping new navigation.
 */
export const MCP_KIT_FIXTURE_VIEW: WorkspaceViewBinding = {
  id: MCP_KIT_FIXTURE_VIEW_ID,
  icon: Plug,
  layout: {
    web: ({ ctx }) => <FixtureMcpUiKit ctx={ctx} experience="web" />,
    app: ({ ctx, depth }) => <FixtureMcpUiKit ctx={ctx} experience="app" depth={depth} />,
  },
};
