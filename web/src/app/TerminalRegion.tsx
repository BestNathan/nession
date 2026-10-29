import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { TerminalPane } from '@/product/terminal/TerminalPane';
import { TerminalSurface } from '@/product/terminal/patterns/TerminalSurface';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import type {
  CapsuleCapabilityProjection,
  CapsuleExperience,
} from '@/product/terminal/capsule/types';
import { useTerminalOrchestration } from '@/product/terminal/useTerminalOrchestration';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';

export interface TerminalRegionProps {
  hidden: boolean;
  onError: (error: Error) => void;
  /** Which experience's capsule to render — supplied by the shell. */
  experience: CapsuleExperience;
  /** What the capsule may show: the chip that earned presence, plus the rest on demand. */
  capsuleCapabilities?: CapsuleCapabilityContribution;
  capsuleProjection?: CapsuleCapabilityProjection;
  onOpenWorkspaceFile?: (path: string, line?: number) => void;
  /** The shell's surface-navigation action beside the capsule (#1204). */
  surfaceAction?: ReactNode;
  /** Work-awareness context (#1347): whether any capability is working. */
  workContext?: ResolvedWorkContext;
}

/**
 * Session-first terminal entry — native surface + shared xterm engine.
 * Does not use legacy TerminalLayout / dashboard terminal chrome.
 */
export function TerminalRegion({
  hidden,
  onError,
  experience,
  capsuleCapabilities,
  capsuleProjection,
  onOpenWorkspaceFile,
  surfaceAction,
  workContext,
}: TerminalRegionProps) {
  const {
    sessionId,
    controller,
    isSwitching,
    inputDisabled,
    viewportReady,
    terminalState,
    historyDegraded,
    streamState,
    terminalControl,
    onTakeControl,
    onTerminalGesture,
    inputDrop,
    dismissInputDrop,
    clipboardNotice,
    dismissClipboardNotice,
  } = useTerminalOrchestration({ onError, foreground: !hidden });

  // A real gesture **inside the terminal grid** is a request to work here, and
  // therefore to control the session (#2286). Pointer and key events on the
  // surrounding chrome — the capsule, the observer bar, an overlay — are
  // deliberately excluded: they are not terminal activation.
  const handleTerminalGesture = (
    event: ReactPointerEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.xterm')) {
      onTerminalGesture();
    }
  };

  return (
    <div
      data-testid="terminal"
      className={cn('flex min-h-0 flex-1 flex-col', hidden && 'hidden')}
      onPointerDownCapture={handleTerminalGesture}
      onKeyDownCapture={handleTerminalGesture}
    >
      {!sessionId ? (
        <div className={cn('flex min-h-0 flex-1 items-center justify-center text-muted-foreground', chromeSansRole('secondary'))}>
          Select a session to open its terminal.
        </div>
      ) : (
        <TerminalSurface
          experience={experience}
          inputDisabled={inputDisabled}
          controller={controller}
          isSwitching={isSwitching}
          capsuleCapabilities={capsuleCapabilities}
          capsuleProjection={capsuleProjection}
          surfaceAction={surfaceAction}
          terminalControl={terminalControl}
          historyDegraded={historyDegraded}
          streamState={streamState}
          onTakeControl={() => {
            void onTakeControl();
          }}
          inputDrop={inputDrop}
          onDismissInputDrop={dismissInputDrop}
          clipboardNotice={clipboardNotice}
          onDismissClipboardNotice={dismissClipboardNotice}
          workContext={workContext}
        >
          <TerminalPane
            sessionId={sessionId}
            controller={controller}
            terminalState={terminalState}
            viewportReady={viewportReady}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        </TerminalSurface>
      )}
    </div>
  );
}
