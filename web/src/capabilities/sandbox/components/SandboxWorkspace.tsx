import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  WorkspaceContext,
  WorkspaceDepthControl,
  WorkspaceViewProps,
} from '@/app/workspace/workspaceContext';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { cn } from '@/shared/lib/utils';
import { useSandboxContext, type SandboxContextState } from '../hooks/useSandboxContext';
import { useSandboxDraft, type SandboxDraftState } from '../hooks/useSandboxDraft';
import {
  useSandboxPreflight,
  type SandboxPreflightState,
} from '../hooks/useSandboxPreflight';
import {
  useSandboxTransitions,
  type SandboxTransitionsState,
} from '../hooks/useSandboxTransitions';
import type { SandboxActionError } from '../model';
import { SandboxComposer } from './SandboxComposer';
import { SandboxInsideView } from './SandboxInsideView';
import { SandboxUnavailableView } from './SandboxUnavailableView';

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

interface SandboxBodyProps {
  sandbox: SandboxContextState;
  draft: SandboxDraftState;
  preflightState: SandboxPreflightState;
  transitions: SandboxTransitionsState;
  actionError: SandboxActionError | null;
  workingDir: string;
  onWorkingDirChange: (value: string) => void;
}

/** The four truthful states; a pure render of what the Agent answered. */
function SandboxBody({
  sandbox,
  draft,
  preflightState,
  transitions,
  actionError,
  workingDir,
  onWorkingDirChange,
}: SandboxBodyProps) {
  const retry = () => {
    transitions.reset();
    preflightState.clearPreflight();
    sandbox.refresh();
  };
  if (sandbox.loading) {
    return (
      <p
        data-testid="sandbox-loading"
        className={cn(chromeSansRole('secondary'), 'text-muted-foreground')}
      >
        Reading the active Pane’s Sandbox context…
      </p>
    );
  }
  if (sandbox.error || !sandbox.context) {
    return (
      <div data-testid="sandbox-context-error" className="flex flex-col gap-2">
        <p className={cn(chromeSansRole('secondary'), 'text-destructive')}>
          {sandbox.error ?? 'The Sandbox context is unavailable'}
        </p>
        <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
          No Pane is claimed as protected. Retry when the Agent answers.
        </p>
        <div>
          <Button type="button" variant="outline" data-testid="sandbox-retry" onClick={retry}>
            <RefreshCw aria-hidden="true" />
            Retry
          </Button>
        </div>
      </div>
    );
  }
  const context = sandbox.context;
  if (context.status === 'inside') {
    return (
      <>
        {actionError ? (
          <p
            data-testid="sandbox-action-error"
            className={cn(chromeSansRole('secondary'), 'text-destructive')}
          >
            {actionError.message}
          </p>
        ) : null}
        <SandboxInsideView
          context={context}
          busy={transitions.busy}
          onReturnToNative={transitions.returnToNative}
          onFocusPane={transitions.focusPane}
        />
      </>
    );
  }
  if (!context.enterable) {
    return <SandboxUnavailableView context={context} />;
  }
  return (
    <SandboxComposer
      context={context}
      draft={draft}
      preflight={preflightState.preflight}
      preflightBusy={preflightState.preflightBusy}
      busy={transitions.busy}
      actionError={actionError}
      workingDir={workingDir}
      onWorkingDirChange={onWorkingDirChange}
      onPreflight={() => preflightState.runPreflight(draft.draft)}
      onRequestEnter={transitions.requestEnter}
      onFocusPane={transitions.focusPane}
      confirming={transitions.confirming}
      onConfirm={() => {
        if (preflightState.preflight) {
          transitions.confirmEnter(draft.draft, preflightState.preflight);
        }
      }}
      onCancelConfirm={transitions.cancelConfirm}
    />
  );
}

/**
 * The Sandbox capability's Workspace surface (#3124).
 *
 * One capability, two truthful states: inside shows the Agent's observed
 * effective policy read-only; outside shows the explicit draft, preflight and
 * Enter. Unknown and unsupported reserve no Enter and never borrow a previous
 * execution's evidence. The App's single Back is supplied by the shell; this
 * view only declares its one pushed depth.
 */
export function SandboxWorkspace({
  ctx,
  depth,
}: {
  ctx: WorkspaceContext;
  depth?: WorkspaceDepthControl;
}) {
  const sessionId = ctx.session?.session_id ?? null;
  const sandbox = useSandboxContext(sessionId);
  const draft = useSandboxDraft(sandbox.context);
  const [workingDir, setWorkingDir] = useState('');
  const preflightState = useSandboxPreflight({
    sessionId,
    context: sandbox.context,
    workingDir,
  });
  const transitions = useSandboxTransitions({
    sessionId,
    workingDir,
    applyContext: sandbox.applyContext,
  });
  useConfirmDepth(depth, transitions.confirming, transitions.cancelConfirm);
  const actionError: SandboxActionError | null =
    transitions.actionError ??
    (preflightState.preflightError
      ? { kind: 'unavailable', message: preflightState.preflightError }
      : null);

  return (
    <div
      data-testid="sandbox-workspace"
      className={cn(
        'flex min-w-0 flex-col gap-4',
        ctx.experience === 'app'
          ? 'p-3'
          : cn('h-full min-h-0 overflow-y-auto p-4', workspaceScrollClearanceClass),
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
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
      <SandboxBody
        sandbox={sandbox}
        draft={draft}
        preflightState={preflightState}
        transitions={transitions}
        actionError={actionError}
        workingDir={workingDir}
        onWorkingDirChange={setWorkingDir}
      />
    </div>
  );
}

/** The Web layout entry: the workspace fills its pane; no chrome of its own. */
export function SandboxWebLayout({ ctx }: WorkspaceViewProps) {
  return <SandboxWorkspace ctx={ctx} />;
}
