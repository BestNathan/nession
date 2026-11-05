import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { CAPSULE_EXPERIENCE } from '@/product/terminal/capsule/config/experience';
import { CapsuleShell } from '@/product/terminal/capsule/components/CapsuleShell';
import { InputComposer } from '@/product/terminal/capsule/components/InputComposer';
import { ComposerMeasureMirror } from '@/product/terminal/capsule/components/ComposerMeasureMirror';
import { CapsuleProvider } from '@/product/terminal/capsule/state/CapsuleProvider';
import { useComposerMeasure } from '@/product/terminal/capsule/state/useComposerMeasure';
import { useCapsuleState } from '@/product/terminal/capsule/state/useCapsuleState';
import { ContextCapsule } from '@/product/terminal/capsule/components/ContextCapsule';
import { PeekHost } from '@/product/terminal/capsule/components/PeekHost';
import {
  layoutFromLineCount,
  type CapsuleCapabilityDisclosure,
  type CapsuleCapabilityProjection,
  type CapsuleExperience,
} from '@/product/terminal/capsule/types';
import { useCapsuleLayoutFlip } from '@/product/terminal/capsule/useCapsuleLayoutFlip';
import { useCapsuleDockClearance } from '@/product/terminal/capsule/hooks/useCapsuleDockClearance';
import { useCapsuleCommandActions } from '@/product/terminal/capsule/hooks/useCapsuleCommandActions';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';

export interface TerminalCapsuleProps {
  sendText: (text: string) => void;
  sendPhysKey?: (key: { seq?: string; semanticKey?: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalSemanticKey }) => void;
  /** One atomic modifier chord, encoded by the terminal interaction runtime. */
  sendChord?: (
    modifier: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalChordModifier,
    key: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalChordKey,
  ) => void;
  disabled?: boolean;
  experience?: CapsuleExperience;
  /** Capabilities that earned no chip, reachable through the disclosure entry. */
  capabilityDisclosure?: CapsuleCapabilityDisclosure;
  /**
   * A capability emerging beside the capsule, if Nession decided one should.
   *
   * Absent in the resting state — which is the state the capsule is designed
   * around, and the one the golden screenshots capture.
   */
  capabilityProjection?: CapsuleCapabilityProjection;
  /**
   * A control composed beside the capsule shell by the shell layer — on Web,
   * the "Open Workspace" destination action (#1204). Opaque to the capsule:
   * it owns a slot in the dock region, never what fills it.
   */
  adjacentAction?: ReactNode;
  /**
   * Contextual, opt-in status action inside the composer (#2658). Present only
   * while the Terminal has notices to disclose; never a permanent toolbar.
   */
  statusAction?: ReactNode;
  /**
   * Work-awareness context (#1347): whether any capability is working.
   *
   * The disclosed Context Capsule is the only consumer of this (#2663): the
   * resting `+` never draws work state.
   */
  workContext?: ResolvedWorkContext;
}

function useContextPeekFocusIntent(projectionId?: string) {
  const intentRef = useRef<string | null>(null);
  const onDeepen = useCallback((capabilityId: string) => {
    intentRef.current = capabilityId;
  }, []);
  const onFocusFromContextHandled = useCallback(() => {
    if (projectionId && intentRef.current === projectionId) {
      intentRef.current = null;
    }
  }, [projectionId]);

  return {
    onDeepen,
    focusFromContext: Boolean(projectionId && intentRef.current === projectionId),
    onFocusFromContextHandled,
  };
}

export function TerminalCapsule({
  sendText,
  sendPhysKey,
  sendChord,
  disabled = false,
  experience = 'web',
  capabilityDisclosure,
  capabilityProjection,
  adjacentAction,
  statusAction,
  workContext,
}: TerminalCapsuleProps) {
  const resolvedExperience = experience;
  const experienceConfig = CAPSULE_EXPERIENCE[resolvedExperience];

  const state = useCapsuleState({ sendText, disabled });

  const shellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRowRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  /**
   * A projection that claims the keyboard, and the composer competing for it.
   *
   * Both halves of #1034's input-focus rules read one boolean the capability
   * declared — never a capability id — so the capsule stays generic: a second
   * tap-driven accessory arrives with the flag and this file does not change.
   */
  const projectionOwnsInputFocus = Boolean(capabilityProjection?.ownsInputFocus);
  const projectionId = capabilityProjection?.id ?? null;
  const peekFocus = useContextPeekFocusIntent(capabilityProjection?.id);

  const handleFieldFocus = useCapsuleInputFocus({
    projectionId,
    projectionOwnsInputFocus,
    capabilityProjection,
    fieldRef,
  });

  // Composer-only terminal fit stays exactly what it was; the hook also
  // publishes the upper panel's *scroll* clearance as a separate value, so an
  // expanded surface never reflows the terminal grid (#2710 SC-08/SC-09).
  useCapsuleDockClearance(shellRef, dockRef);

  const { applyLineCount, composerLayout, send: stateSend, ...restState } = state;
  const { captureBeforeLayoutChange } = useCapsuleLayoutFlip(composerLayout, inputRowRef);

  const handleLineCountChange = useCallback(
    (lineCount: number) => {
      const next = layoutFromLineCount(lineCount);
      if (next !== composerLayout) {
        captureBeforeLayoutChange();
      }
      applyLineCount(lineCount);
    },
    [applyLineCount, captureBeforeLayoutChange, composerLayout],
  );

  const send = useCallback(() => {
    if (composerLayout === 'stacked') {
      captureBeforeLayoutChange();
    }
    stateSend();
  }, [captureBeforeLayoutChange, composerLayout, stateSend]);

  const { insertText, runCommand } = restState;
  const { handleInsertText, handleRunCommand } = useCapsuleCommandActions({
    insertText,
    runCommand,
    capabilityProjection,
    fieldRef,
  });

  const measureMirrorRef = useComposerMeasure({
    value: restState.inputValue,
    shellRef,
    contentWidthRef: contentRef,
    onLineCountChange: handleLineCountChange,
  });

  const upperLayer = (
    <CapsuleUpperLayer
      contextOpen={restState.contextOpen}
      capabilityDisclosure={capabilityDisclosure}
      workContext={workContext}
      onCloseContext={() => restState.setContextOpen(false)}
      onDeepen={peekFocus.onDeepen}
      contextTriggerRef={restState.contextTriggerRef}
      capabilityProjection={capabilityProjection}
      sendText={sendText}
      sendPhysKey={sendPhysKey}
      sendChord={sendChord}
      insertText={handleInsertText}
      runCommand={handleRunCommand}
      disabled={disabled}
      focusFromContext={peekFocus.focusFromContext}
      onFocusFromContextHandled={peekFocus.onFocusFromContextHandled}
    />
  );

  return (
    <CapsuleProvider
      value={{
        ...restState,
        applyLineCount,
        composerLayout,
        send,
        experience: resolvedExperience,
        experienceConfig,
        sendText,
      }}
    >
      <CapsuleShell
        experience={resolvedExperience}
        layout={composerLayout}
        disabled={disabled}
        dockRef={dockRef}
        shellRef={shellRef}
        contentRef={contentRef}
        measureMirror={<ComposerMeasureMirror mirrorRef={measureMirrorRef} />}
        adjacentAction={adjacentAction}
        projection={upperLayer}
      >
        <InputComposer
          ref={inputRowRef}
          capabilityDisclosure={capabilityDisclosure}
          onFieldFocus={handleFieldFocus}
          fieldRef={fieldRef}
          statusAction={statusAction}
        />
      </CapsuleShell>
    </CapsuleProvider>
  );
}

/**
 * The dock's one upper layer (#1347 SC-43): the Context Capsule while it is
 * open, otherwise the capability Peek, otherwise nothing.
 *
 * One slot rather than two, deliberately. The owner's model is that selecting a
 * row *deepens this layer* — the list becomes the Peek — so two slots would
 * allow a state the design does not have (a list with a Peek above it). It also
 * means the lower capsule is untouched by construction: nothing here renders
 * inside it.
 */
function CapsuleUpperLayer({
  contextOpen,
  capabilityDisclosure,
  workContext,
  onCloseContext,
  onDeepen,
  contextTriggerRef,
  capabilityProjection,
  sendText,
  sendPhysKey,
  sendChord,
  insertText,
  runCommand,
  disabled,
  focusFromContext,
  onFocusFromContextHandled,
}: {
  contextOpen: boolean;
  capabilityDisclosure?: CapsuleCapabilityDisclosure;
  workContext?: ResolvedWorkContext;
  onCloseContext: () => void;
  onDeepen: (capabilityId: string) => void;
  contextTriggerRef: React.RefObject<HTMLButtonElement | null>;
  capabilityProjection?: CapsuleCapabilityProjection;
  sendText: (text: string) => void;
  sendPhysKey?: TerminalCapsuleProps['sendPhysKey'];
  sendChord?: TerminalCapsuleProps['sendChord'];
  insertText: (text: string) => void;
  runCommand: (text: string) => void;
  disabled: boolean;
  focusFromContext: boolean;
  onFocusFromContextHandled: () => void;
}) {
  if (contextOpen && capabilityDisclosure) {
    return (
      <ContextCapsule
        disclosure={capabilityDisclosure}
        workContext={workContext}
        onDismiss={onCloseContext}
        onDeepen={onDeepen}
        triggerRef={contextTriggerRef}
      />
    );
  }
  if (!capabilityProjection) {
    return null;
  }
  return (
    <PeekHost
      projection={capabilityProjection}
      sendText={sendText}
      sendPhysKey={sendPhysKey}
      sendChord={sendChord}
      insertText={insertText}
      runCommand={runCommand}
      disabled={disabled}
      triggerRef={contextTriggerRef}
      focusFromContext={focusFromContext}
      onFocusFromContextHandled={onFocusFromContextHandled}
    />
  );
}

/**
 * The projection/composer keyboard contract (#1034 §5, criteria 7/8/14).
 *
 * Blurring the field is *how* a soft keyboard is dismissed — there is no
 * declarative equivalent — and leaving it focused would put the IME on top of
 * the keys the accessory exists to expose. Keyed on the projection's identity
 * as well as the flag, so a projection that replaces another still claims the
 * keyboard on arrival.
 *
 * …and the composer takes it back when the user reaches for it. Tapping the
 * field dismisses the projection rather than merely focusing the field: that is
 * what makes the two secondary surfaces exclusive and returns the user to text
 * entry. The dismissal steps the projection out and nothing else — the Session
 * and the Terminal are not touched.
 */
function useCapsuleInputFocus({
  projectionId,
  projectionOwnsInputFocus,
  capabilityProjection,
  fieldRef,
}: {
  projectionId: string | null;
  projectionOwnsInputFocus: boolean;
  capabilityProjection?: CapsuleCapabilityProjection;
  fieldRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  useEffect(() => {
    if (projectionOwnsInputFocus) {
      fieldRef.current?.blur();
    }
  }, [fieldRef, projectionId, projectionOwnsInputFocus]);

  return useCallback(() => {
    if (projectionOwnsInputFocus) {
      capabilityProjection?.onDismiss();
    }
  }, [capabilityProjection, projectionOwnsInputFocus]);
}
