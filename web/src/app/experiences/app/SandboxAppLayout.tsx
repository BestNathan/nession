import { SandboxWorkspace } from '@/capabilities/sandbox';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';

/**
 * The App's Sandbox layout (#3124, #4115).
 *
 * The capability owns no navigation chrome: the pushed Enter confirmation is
 * declared through `depth`, and `WorkspacePanel` renders the one App Back for
 * it. It also owns no scroll chrome: Sandbox content flows normally, so the
 * App host's page scrollport (`AppWorkspaceScrollRegion`) is the single scroll
 * owner and supplies the measured Capsule clearance. The form and its pushed
 * page therefore get correct end-of-scroll geometry without either of them
 * computing a Capsule inset.
 */
export function SandboxAppLayout({ ctx, depth }: WorkspaceAppViewProps) {
  return (
    <div data-testid="sandbox-app-scroll">
      <SandboxWorkspace ctx={ctx} depth={depth} />
    </div>
  );
}
