import { useCallback, useRef } from 'react';
import { CAPSULE_EXPERIENCE } from '@/session-first/capsule/config/experience';
import { CapsuleModeToggle } from '@/session-first/capsule/CapsuleModeToggle';
import { CapsuleShell } from '@/session-first/capsule/components/CapsuleShell';
import { CommandsComposer } from '@/session-first/capsule/components/CommandsComposer';
import { InputComposer } from '@/session-first/capsule/components/InputComposer';
import { ComposerMeasureMirror } from '@/session-first/capsule/components/ComposerMeasureMirror';
import { CapsuleProvider } from '@/session-first/capsule/state/CapsuleProvider';
import { useComposerMeasure } from '@/session-first/capsule/state/useComposerMeasure';
import { useCapsuleState } from '@/session-first/capsule/state/useCapsuleState';
import {
  experienceFromVariant,
  layoutFromLineCount,
  type CapsuleExperience,
  type CapsuleMode,
  type CapsuleVariant,
} from '@/session-first/capsule/types';
import { useCapsuleLayoutFlip } from '@/session-first/capsule/useCapsuleLayoutFlip';
import { useCapsuleDockClearance } from '@/session-first/capsule/hooks/useCapsuleDockClearance';

export interface TerminalCapsuleProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  /** @deprecated Use experience */
  variant?: CapsuleVariant;
  experience?: CapsuleExperience;
  mode?: CapsuleMode;
  onModeChange?: (mode: CapsuleMode) => void;
}

export function TerminalCapsule({
  sendText,
  disabled = false,
  variant,
  experience,
  mode = 'input',
  onModeChange,
}: TerminalCapsuleProps) {
  const resolvedExperience =
    experience ?? (variant ? experienceFromVariant(variant) : 'web');
  const experienceConfig = CAPSULE_EXPERIENCE[resolvedExperience];
  const isApp = resolvedExperience === 'app';
  const activeMode = isApp ? mode : 'input';
  const isCommandsMode = isApp && activeMode === 'commands';
  const allowLayoutChanges = !isApp || activeMode === 'input';

  const state = useCapsuleState({
    sendText,
    disabled,
    mode: activeMode,
    onModeChange,
    allowLayoutChanges,
  });

  const shellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRowRef = useRef<HTMLDivElement>(null);

  useCapsuleDockClearance(dockRef);

  const showModeToggle = Boolean(isApp && onModeChange && experienceConfig.inputControls.modeToggle);
  const {
    applyLineCount,
    composerLayout,
    send: stateSend,
    ...restState
  } = state;

  const { captureBeforeLayoutChange } = useCapsuleLayoutFlip(
    composerLayout,
    inputRowRef,
  );

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

  const measureMirrorRef = useComposerMeasure({
    value: restState.inputValue,
    shellRef,
    contentWidthRef: contentRef,
    onLineCountChange: handleLineCountChange,
    enabled: allowLayoutChanges && !isCommandsMode,
  });

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
        mode={activeMode}
        disabled={disabled}
        dockRef={dockRef}
        shellRef={shellRef}
        contentRef={contentRef}
        measureMirror={<ComposerMeasureMirror mirrorRef={measureMirrorRef} />}
      >
        {isCommandsMode && onModeChange ? (
          <>
            <CapsuleModeToggle mode={mode} onModeChange={onModeChange} disabled={disabled} />
            <CommandsComposer />
          </>
        ) : (
          <InputComposer
            ref={inputRowRef}
            leading={
              showModeToggle && onModeChange ? (
                <CapsuleModeToggle mode={mode} onModeChange={onModeChange} disabled={disabled} />
              ) : null
            }
          />
        )}
      </CapsuleShell>
    </CapsuleProvider>
  );
}

export type { CapsuleMode } from '@/session-first/capsule/types';
