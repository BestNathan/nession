import { cn } from '@/shared/lib/utils';
import {
  capsuleExchangeStyle,
  useCapsuleExchange,
} from '@/platform/motion/capsuleExchange';
import {
  capsuleOuterGeometry,
  capsuleShellAppDockBottomClass,
  capsuleShellAppOuterClass,
  capsuleShellDockBottomClass,
  capsuleShellWebOuterClass,
} from '@/product/terminal/capsule/capsuleStyles';
import type {
  CapsuleExperience,
  ComposerLayout,
} from '@/product/terminal/capsule/types';
import { dockHeightFromLayout } from '@/product/terminal/capsule/measure/layoutFromLineCount';

interface CapsuleShellProps {
  experience: CapsuleExperience;
  layout?: ComposerLayout;
  disabled?: boolean;
  dockRef?: React.Ref<HTMLDivElement>;
  shellRef?: React.Ref<HTMLDivElement>;
  contentRef?: React.Ref<HTMLDivElement>;
  measureMirror?: React.ReactNode;
  /**
   * Something emerging above the capsule — a capability Signal or Peek.
   *
   * A slot rather than a capability concept: the shell renders what it is
   * given and knows nothing about what it means. It sits outside the shell
   * surface, so the capsule's own box is unaffected by whether anything is
   * there.
   */
  projection?: React.ReactNode;
  /**
   * A control belonging to the capsule's dock region but not to the composer —
   * on Web, the "Open Workspace" destination action (#1204).
   *
   * A slot for the same reason `projection` is: the capsule renders what it is
   * given and learns no navigation concepts. It sits in the shell's row,
   * bottom-aligned, so its top can never rise above the shell's top edge —
   * which means `useCapsuleDockClearance` (measuring the shell alone) already
   * covers it, and an action no taller than the shell adds no terminal row
   * loss. App passes nothing and its layout is untouched.
   */
  adjacentAction?: React.ReactNode;
  children: React.ReactNode;
}

export function CapsuleShell({
  experience,
  layout = 'flat',
  disabled,
  dockRef,
  shellRef,
  contentRef,
  measureMirror,
  projection,
  adjacentAction,
  children,
}: CapsuleShellProps) {
  const isApp = experience === 'app';
  // One derivation for both Capsule states (#1347 SC-29/SC-30) — see
  // `capsuleOuterGeometry`, which also states why width is not part of it.
  const geometry = capsuleOuterGeometry(experience, layout);

  // The App's capsule handoff (see `capsuleExchange`): while a swipe carries
  // the Workspace over the Terminal, the Conversation form steps aside and
  // fades with the finger. The whole dock moves as one object — shell,
  // projection and adjacent action together — and X-only transforms leave
  // `useCapsuleDockClearance`'s vertical measurement untouched. On Web there
  // is no exchange and the endpoints apply no style at all.
  const exchange = useCapsuleExchange();
  const exchangeStyle = capsuleExchangeStyle(exchange, 'yielding');

  const shell = (
    <div
      ref={shellRef}
      data-testid="capsule-shell"
      /* Reciprocal morph key (#1347 SC-08): the Workspace's capability capsule
         carries the same id, so a surface switch slides each from the other's
         former place. Not `data-flip-id` — that namespace belongs to the
         intra-capsule composer FLIP. */
      data-morph-id="capsule-shell"
      className={cn(
        geometry.shellClass,
        // In the adjacent row the shell shares the dock's width with the
        // action: `flex-1` (basis 0%) supersedes the derived `w-full` for a flex
        // item, so the capsule yields the action's width rather than
        // overflowing the group (#1204 §8).
        adjacentAction && 'min-w-0 flex-1',
      )}
    >
      <div
        ref={contentRef}
        data-testid="capsule-shell-content"
        className="flex min-w-0 flex-1 items-center overflow-hidden"
      >
        {children}
      </div>
    </div>
  );

  return (
    <div
      ref={dockRef}
      data-testid="terminal-capsule"
      data-experience={experience}
      data-disabled={disabled ? 'true' : undefined}
      data-layout={layout}
      data-dock-height={dockHeightFromLayout(layout)}
      data-shell-shape={geometry.shape}
      data-capsule-exchange={exchangeStyle ? 'yielding' : undefined}
      style={exchangeStyle}
      className={cn(
        'absolute z-30 flex flex-col',
        isApp ? capsuleShellAppOuterClass : capsuleShellWebOuterClass,
        isApp ? capsuleShellAppDockBottomClass : capsuleShellDockBottomClass,
      )}
    >
      {projection}
      {adjacentAction ? (
        /* `items-end` pins the action to the shell's bottom edge, so a composer
           growing upward never lifts the action above the shell's top — the
           shell-only occlusion measurement stays exact (#1204 §1). */
        <div className="flex items-end gap-[length:var(--shell-space-2)]">
          {shell}
          {adjacentAction}
        </div>
      ) : (
        shell
      )}
      {measureMirror}
    </div>
  );
}
