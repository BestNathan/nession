import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/shared/lib/utils';
import type { FileOps } from '@/capabilities/files';
import type { CapabilityFacts, CapabilityId } from '@/product/capability';
import type { DomainState } from '@/product/session/model/domainState';
import type { Agent, Session } from '@/types';
import { AppPageHeader } from '@/app/patterns/AppPageHeader';
import type { Surface } from '@/app/patterns/SessionHeader';
import { WorkspaceShell } from '@/app/workspace/WorkspaceShell';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import type {
  CapabilityFocus,
  Experience,
  WorkspaceContext,
  WorkspaceDepthControl,
  WorkspacePush,
} from '@/app/workspace/workspaceContext';

export interface WorkspacePanelProps {
  selectedSession: Session;
  selectedAgent: Agent | undefined;
  agents: Agent[];
  domain: DomainState;
  surface: Surface;
  tool: CapabilityId;
  fileOps: FileOps | null;
  experience: Experience;
  facts: CapabilityFacts | undefined;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: CapabilityId) => void;
  /**
   * Reports whether a capability has pushed a detail depth (#1081).
   *
   * Read by the App's pager, which must not offer a second leave for a depth
   * that already has one. Absent on Web, which has no top-level gesture.
   */
  onDepthChange?: (pushed: boolean) => void;
  /** What opened this view, when the entry carried context (`#826`). */
  focus?: CapabilityFocus;
}

/** Which capability registered the push on screen. */
interface PushedDepth {
  capabilityId: CapabilityId;
  push: WorkspacePush;
}

/**
 * The Workspace page and its one navigation bar (#1051).
 *
 * The chrome owner for whatever depth the Workspace is at. It renders the App's
 * page header, hands the capability's view a `WorkspaceDepthControl` to declare a
 * pushed depth through, and tells the dock whether it is still at the depth that
 * may show it.
 *
 * The push is stamped with the capability that registered it rather than cleared
 * by an effect when `tool` changes. Switching capability unmounts the view that
 * pushed, so there is no cleanup to run — and a stale push read for even one
 * frame would put another capability's file name in the header.
 */
export function WorkspacePanel({
  selectedSession,
  selectedAgent,
  agents,
  domain,
  surface,
  tool,
  fileOps,
  experience,
  facts,
  onSurfaceChange,
  onToolChange,
  onDepthChange,
  focus,
}: WorkspacePanelProps) {
  const [pushed, setPushed] = useState<PushedDepth | null>(null);

  // Report the depth upward rather than keeping it private (#1081): the App's
  // pager needs it, and this is the component that owns it. The panel is
  // unmounted whenever the Workspace layer is closed, so the reset on the way
  // out is what keeps a stale `true` from silencing the Terminal's gesture —
  // and it is a separate effect because the reporting one would otherwise clear
  // and re-set on every push, which is a state change nothing asked for.
  useEffect(() => {
    onDepthChange?.(pushed !== null);
  }, [pushed, onDepthChange]);

  useEffect(() => {
    return () => onDepthChange?.(false);
  }, [onDepthChange]);

  const ctx: WorkspaceContext = useMemo(
    () => ({
      session: selectedSession,
      agent: selectedAgent,
      agents,
      domain,
      fileOps,
      experience,
      onToolChange,
      facts,
      focus,
    }),
    [
      selectedSession,
      selectedAgent,
      agents,
      domain,
      fileOps,
      experience,
      onToolChange,
      facts,
      focus,
    ],
  );

  // The header names the capability the user opened. Names live in the
  // capability layer alongside availability, so chrome reads them from there
  // rather than from a table kept next to the views.
  const activeLabel = useMemo(
    () =>
      resolveWorkspaceCapabilities(ctx).snapshots.find((snapshot) => snapshot.id === tool)?.title ??
      'Workspace',
    [ctx, tool],
  );

  const setPush = useCallback(
    (push: WorkspacePush | null) => {
      setPushed(push === null ? null : { capabilityId: tool, push });
    },
    [tool],
  );
  const depth: WorkspaceDepthControl = useMemo(() => ({ setPush }), [setPush]);

  const push = pushed && pushed.capabilityId === tool ? pushed.push : null;

  return (
    <div
      role="region"
      id="workspace-capability-panel"
      aria-label="Workspace"
      className={cn('flex min-h-0 flex-1 flex-col', surface !== 'workspace' && 'hidden')}
    >
      {experience === 'app' ? (
        <AppPageHeader
          /* Back goes to the depth below this one, and nowhere else: the Terminal
             from a capability root, the capability root from a pushed detail.
             `#1051`'s rule is one predictable leave per depth, so this is the
             only affordance in the App that leaves either of them. */
          backLabel={push ? `Back to ${activeLabel}` : 'Back to terminal'}
          onBack={push ? push.onLeave : () => onSurfaceChange('terminal')}
          title={push ? push.title : activeLabel}
          technical={push !== null}
        />
      ) : null}
      <WorkspaceShell ctx={ctx} activeCapabilityId={tool} depth={depth} pushed={push !== null} />
    </div>
  );
}
