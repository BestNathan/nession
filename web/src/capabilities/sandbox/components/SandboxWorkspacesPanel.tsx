import {
  DetailEmpty,
  DetailHeader,
  DetailSurface,
} from '@/components/ui/resource-detail';

/**
 * The Sandbox Workspaces section (#3408, resource model #3407).
 *
 * The inventory and lifecycle are owned by the Agent Workspace Manager. This
 * view does not invent a second registry; the honest empty state says the
 * current Agent build does not expose that inventory yet.
 */
export function SandboxWorkspacesPanel() {
  return (
    <DetailSurface data-testid="sandbox-workspaces">
      <DetailHeader
        level="h2"
        title="Workspaces"
        description="Reusable Agent-owned workspace resources and current Project Location references."
      />
      <DetailEmpty data-testid="sandbox-workspaces-empty">
        This Agent build does not expose its Workspace inventory yet. When it does, managed
        Workspaces and Project Locations will be listed here; the Filesystem policy only selects
        one and never duplicates the registry.
      </DetailEmpty>
    </DetailSurface>
  );
}
