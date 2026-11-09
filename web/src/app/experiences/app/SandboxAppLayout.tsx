import { AppToolScroll } from './AppToolScroll';
import { SandboxWorkspace } from '@/capabilities/sandbox';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';

/**
 * The App's Sandbox layout (#3124).
 *
 * The capability owns no navigation chrome: the pushed Enter confirmation is
 * declared through `depth`, and `WorkspacePanel` renders the one App Back for
 * it. `AppToolScroll` supplies the capsule's bottom clearance for both the
 * root form and the pushed page.
 */
export function SandboxAppLayout({ ctx, depth }: WorkspaceAppViewProps) {
  return (
    <AppToolScroll data-testid="sandbox-app-scroll">
      <SandboxWorkspace ctx={ctx} depth={depth} />
    </AppToolScroll>
  );
}
