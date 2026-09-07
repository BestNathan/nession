import { cn } from '@/lib/utils';
import {
  capsuleShellAppDockBottomClass,
  capsuleShellAppOuterClass,
  capsuleShellCapsuleRadiusClass,
  capsuleShellContentGapClass,
  capsuleShellDockBottomClass,
  capsuleShellInnerClass,
  capsuleShellInnerPadClass,
  capsuleShellPillRadiusClass,
  capsuleShellSurfaceClass,
  capsuleShellWebOuterClass,
} from '@/session-first/capsule/capsuleStyles';
import { useCapsuleContext } from '@/session-first/capsule/state/useCapsuleContext';
import type {
  CapsuleExperience,
  CapsuleMode,
  ComposerLayout,
} from '@/session-first/capsule/types';
import { dockHeightFromLayout } from '@/session-first/capsule/measure/layoutFromLineCount';

interface CapsuleShellProps {
  experience: CapsuleExperience;
  layout?: ComposerLayout;
  mode?: CapsuleMode;
  disabled?: boolean;
  dockRef?: React.Ref<HTMLDivElement>;
  shellRef?: React.Ref<HTMLDivElement>;
  contentRef?: React.Ref<HTMLDivElement>;
  measureMirror?: React.ReactNode;
  children: React.ReactNode;
}

export function CapsuleShell({
  experience,
  layout = 'flat',
  mode = 'input',
  disabled,
  dockRef,
  shellRef,
  contentRef,
  measureMirror,
  children,
}: CapsuleShellProps) {
  const { commandsOpen } = useCapsuleContext();
  const isCommandsMode = mode === 'commands';
  const commandsPanelExpanded = isCommandsMode && commandsOpen;
  const showLayout = !isCommandsMode;
  const isApp = experience === 'app';
  const usePillShape =
    (isApp && isCommandsMode && !commandsOpen) ||
    (!isCommandsMode && layout === 'flat' && !isApp);

  return (
    <div
      ref={dockRef}
      data-testid="terminal-capsule"
      data-experience={experience}
      data-disabled={disabled ? 'true' : undefined}
      data-layout={showLayout ? layout : undefined}
      data-dock-height={showLayout ? dockHeightFromLayout(layout) : 'single'}
      data-shell-shape={usePillShape ? 'pill' : 'capsule'}
      className={cn(
        'absolute z-20 flex flex-col',
        isApp ? capsuleShellAppOuterClass : capsuleShellWebOuterClass,
        isApp ? capsuleShellAppDockBottomClass : capsuleShellDockBottomClass,
      )}
    >
      <div
        ref={shellRef}
        data-testid="capsule-shell"
        className={cn(
          'flex min-h-[length:var(--control-md)]',
          capsuleShellInnerClass,
          capsuleShellSurfaceClass,
          usePillShape ? capsuleShellPillRadiusClass : capsuleShellCapsuleRadiusClass,
          capsuleShellInnerPadClass,
          commandsPanelExpanded
            ? 'flex-col'
            : cn('items-center', isCommandsMode && capsuleShellContentGapClass),
        )}
      >
        <div
          ref={contentRef}
          data-testid="capsule-shell-content"
          className={cn(
            'flex min-w-0 flex-1 overflow-hidden',
            commandsPanelExpanded
              ? 'flex-col items-stretch'
              : cn('items-center', isCommandsMode && capsuleShellContentGapClass),
          )}
        >
          {children}
        </div>
      </div>
      {measureMirror}
    </div>
  );
}
