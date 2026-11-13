import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  WorkspaceContext,
  WorkspaceDepthControl,
  WorkspaceViewProps,
} from '@/app/workspace/workspaceContext';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { useSandboxContext, type SandboxContextState } from '../hooks/useSandboxContext';
import { useSandboxDraft, type SandboxDraftState } from '../hooks/useSandboxDraft';
import { useSandboxImages, type SandboxImagesState } from '../hooks/useSandboxImages';
import {
  useSandboxPreflight,
  type SandboxPreflightState,
} from '../hooks/useSandboxPreflight';
import {
  useSandboxTransitions,
  type SandboxTransitionsState,
} from '../hooks/useSandboxTransitions';
import {
  preflightIsValid,
  sandboxDraftSignature,
  type SandboxActionError,
} from '../model';
import { SandboxConfirmView } from './SandboxConfirmView';
import { SandboxOverview, SandboxPolicyPanels } from './SandboxComposer';
import { SandboxImagesPanel } from './SandboxImagesPanel';
import {
  SandboxInsideOverview,
  SandboxInsidePolicyPanels,
} from './SandboxInsideView';
import {
  SandboxSectionNav,
  type SandboxSectionId,
} from './SandboxSectionNav';
import { SandboxUnavailableView } from './SandboxUnavailableView';
import { SandboxWorkspacesPanel } from './SandboxWorkspacesPanel';
import type { SandboxPolicyId } from './SandboxPolicyTabs';

/** Declare the App's one pushed depth while the confirmation is showing. */
function useConfirmDepth(
  depth: WorkspaceDepthControl | undefined,
  confirming: boolean,
  onLeave: () => void,
) {
  useEffect(() => {
    if (!depth) {
      return;
    }
    if (confirming) {
      depth.setPush({ title: 'Enter Sandbox', onLeave });
    } else {
      depth.setPush(null);
    }
    return () => depth.setPush(null);
  }, [confirming, depth, onLeave]);
}

interface SandboxContentProps {
  ctx: WorkspaceContext;
  sandbox: SandboxContextState;
  draft: SandboxDraftState;
  preflightState: SandboxPreflightState;
  transitions: SandboxTransitionsState;
  actionError: SandboxActionError | null;
  workingDir: string;
  onWorkingDirChange: (value: string) => void;
  images: SandboxImagesState;
  activeSection: SandboxSectionId;
  activePolicy: SandboxPolicyId;
  onPolicyChange: (policy: SandboxPolicyId) => void;
  onRetry: () => void;
}

function SandboxContextNotice({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <p
        data-testid="sandbox-loading"
        className={cn(chromeSansRole('secondary'), 'text-muted-foreground')}
      >
        Reading the active Pane’s Sandbox context…
      </p>
    );
  }
  return (
    <div data-testid="sandbox-context-error" className="flex flex-col gap-2">
      <p className={cn(chromeSansRole('secondary'), 'text-destructive')}>
        {error ?? 'The Sandbox context is unavailable'}
      </p>
      <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
        No Pane is claimed as protected. Retry when the Agent answers.
      </p>
      <div>
        <Button type="button" variant="outline" data-testid="sandbox-retry" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </div>
    </div>
  );
}

function SandboxContent({
  ctx,
  sandbox,
  draft,
  preflightState,
  transitions,
  actionError,
  workingDir,
  onWorkingDirChange,
  images,
  activeSection,
  activePolicy,
  onPolicyChange,
  onRetry,
}: SandboxContentProps) {
  const context = sandbox.context;
  const signature = sandboxDraftSignature(draft.draft, images.selections);
  const preflightValid = preflightIsValid(
    preflightState.preflight,
    signature,
    context?.generation ?? '',
    context?.catalog.probe_generation ?? '',
  );

  if (sandbox.loading || sandbox.error || !context) {
    return (
      <SandboxContextNotice
        loading={sandbox.loading}
        error={sandbox.error}
        onRetry={onRetry}
      />
    );
  }
  if (transitions.confirming) {
    return (
      <SandboxConfirmView
        draft={draft.draft}
        busy={transitions.busy}
        preflightValid={preflightValid}
        actionError={transitions.actionError}
        onConfirm={() => {
          if (preflightState.preflight) {
            transitions.confirmEnter(draft.draft, preflightState.preflight);
          }
        }}
        onCancel={transitions.cancelConfirm}
      />
    );
  }
  if (activeSection === 'images') {
    return <SandboxImagesPanel experience={ctx.experience} />;
  }
  if (activeSection === 'workspaces') {
    return <SandboxWorkspacesPanel />;
  }
  if (context.status === 'inside') {
    if (activeSection === 'policies') {
      return (
        <SandboxInsidePolicyPanels
          context={context}
          busy={transitions.busy}
          onReturnToNative={transitions.returnToNative}
          onFocusPane={transitions.focusPane}
          experience={ctx.experience}
          activePolicy={activePolicy}
          onPolicyChange={onPolicyChange}
        />
      );
    }
    return (
      <SandboxInsideOverview
        context={context}
        policy={context.effective_policy}
        busy={transitions.busy}
        onReturnToNative={transitions.returnToNative}
        onFocusPane={transitions.focusPane}
        onPolicyChange={onPolicyChange}
      />
    );
  }
  if (!context.enterable) {
    return <SandboxUnavailableView context={context} />;
  }
  const composerProps = {
    context,
    draft,
    preflight: preflightState.preflight,
    preflightBusy: preflightState.preflightBusy,
    busy: transitions.busy,
    actionError,
    workingDir,
    onWorkingDirChange,
    images,
    onPreflight: () => preflightState.runPreflight(draft.draft),
    onRequestEnter: transitions.requestEnter,
    onFocusPane: transitions.focusPane,
    experience: ctx.experience,
    activePolicy,
    onPolicyChange,
  };
  if (activeSection === 'policies') {
    return <SandboxPolicyPanels {...composerProps} />;
  }
  return <SandboxOverview {...composerProps} />;
}

/**
 * The Sandbox capability's Workspace surface (#3124, #3408).
 *
 * Four capability-local sections: Overview, Images, Workspaces and Policies.
 * The Server Images registry and the Agent Workspace inventory keep their
 * existing owners; this view composes them inside the selected Session.
 * Overview owns the preflight/Enter flow, while Policies carries the five
 * native/portable policy editors (or their read-only inside projection).
 */
export function SandboxWorkspace({
  ctx,
  depth,
}: {
  ctx: WorkspaceContext;
  depth?: WorkspaceDepthControl;
}) {
  const sessionId = ctx.session?.session_id ?? null;
  const [activeSection, setActiveSection] = useState<SandboxSectionId>('overview');
  const [activePolicy, setActivePolicy] = useState<SandboxPolicyId>('filesystem');
  const sandbox = useSandboxContext(sessionId);
  const draft = useSandboxDraft(sandbox.context);
  const images = useSandboxImages(sessionId);
  const [workingDir, setWorkingDir] = useState('');
  const preflightState = useSandboxPreflight({
    sessionId,
    context: sandbox.context,
    images: images.selections,
    workingDir,
  });
  const transitions = useSandboxTransitions({
    sessionId,
    images: images.selections,
    workingDir,
    applyContext: sandbox.applyContext,
  });
  useConfirmDepth(depth, transitions.confirming, transitions.cancelConfirm);
  const actionError: SandboxActionError | null =
    transitions.actionError ??
    (preflightState.preflightError
      ? { kind: 'unavailable', message: preflightState.preflightError }
      : null);
  const selectPolicy = (policy: SandboxPolicyId) => {
    setActivePolicy(policy);
    setActiveSection('policies');
  };

  return (
    <div
      data-testid="sandbox-workspace"
      className={cn(
        'flex min-w-0 flex-col gap-3',
        ctx.experience === 'app' ? 'p-3' : 'h-full min-h-0 p-4',
      )}
    >
      <div
        className={cn(
          'flex min-w-0 gap-2',
          ctx.experience === 'web' ? 'items-center justify-between' : 'flex-col',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid="sandbox-session-name"
            className={cn(chromeSansRole('caption'), 'min-w-0 truncate text-muted-foreground')}
          >
            {ctx.session?.session_name ?? 'No Session'}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid="sandbox-refresh"
            aria-label="Refresh Sandbox context"
            onClick={sandbox.refresh}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
        <SandboxSectionNav
          experience={ctx.experience}
          value={activeSection}
          onValueChange={setActiveSection}
        />
      </div>
      {actionError ? (
        <p
          data-testid="sandbox-action-error"
          className={cn(chromeSansRole('secondary'), 'text-destructive')}
        >
          {actionError.message}
        </p>
      ) : null}
      <div
        className={cn(
          'flex min-w-0 flex-col',
          ctx.experience === 'web' && 'min-h-0 flex-1',
        )}
      >
        <SandboxContent
          ctx={ctx}
          sandbox={sandbox}
          draft={draft}
          preflightState={preflightState}
          transitions={transitions}
          actionError={actionError}
          workingDir={workingDir}
          onWorkingDirChange={setWorkingDir}
          images={images}
          activeSection={activeSection}
          activePolicy={activePolicy}
          onPolicyChange={selectPolicy}
          onRetry={() => {
            transitions.reset();
            preflightState.clearPreflight();
            sandbox.refresh();
          }}
        />
      </div>
    </div>
  );
}

/** The Web layout entry: the workspace fills its pane; no chrome of its own. */
export function SandboxWebLayout({ ctx }: WorkspaceViewProps) {
  return <SandboxWorkspace ctx={ctx} />;
}
