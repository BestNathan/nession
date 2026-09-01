import { cn } from '@/lib/utils';
import {
  capsuleShellContentGapClass,
  capsuleShellInnerPadClass,
  capsuleShellRadiusClass,
  capsuleShellSurfaceClass,
  capsuleShellWebPositionClass,
} from '@/session-first/capsule/capsuleStyles';
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
  shellRef,
  contentRef,
  measureMirror,
  children,
}: CapsuleShellProps) {
  const isCommandsMode = mode === 'commands';
  const showLayout = !isCommandsMode;

  return (
    <div
      data-testid="terminal-capsule"
      data-experience={experience}
      data-disabled={disabled ? 'true' : undefined}
      data-layout={showLayout ? layout : undefined}
      data-dock-height={showLayout ? dockHeightFromLayout(layout) : 'single'}
      className={cn(
        'absolute z-10 flex flex-col',
        experience === 'app'
          ? 'inset-x-[length:var(--composer-shell-inset)] bottom-[max(var(--composer-shell-inset),var(--composer-shell-safe-area))]'
          : capsuleShellWebPositionClass,
      )}
    >
      <div
        ref={shellRef}
        data-testid="capsule-shell"
        className={cn(
          'flex',
          capsuleShellSurfaceClass,
          capsuleShellRadiusClass,
          capsuleShellInnerPadClass,
          isCommandsMode
            ? cn('min-h-[length:var(--control-md)] items-center', capsuleShellContentGapClass)
            : 'items-center',
        )}
      >
        <div ref={contentRef} data-testid="capsule-shell-content" className="flex min-w-0 flex-1">
          {children}
        </div>
      </div>
      {measureMirror}
    </div>
  );
}
