import { useEffect } from 'react';
import type {
  WorkspaceDepthControl,
  WorkspaceStackAncestor,
} from '@/app/workspace/workspaceContext';
import { CLAUDE_ROOT_ANCESTOR, type AppRoute, routeKey } from './model';

/**
 * What Claude's App composition contributes to the one shell header (#3971).
 *
 * The capability never renders chrome: it declares the current depth (primary
 * title, real ancestry, Back label, guarded leave/jump), the recorded forward
 * destination an inner swipe may use, and the semantic actions the host draws.
 * This hook is that declaration surface, kept apart from the state transitions
 * so neither grows a second navigation story.
 */
export function useClaudeAppChrome({
  agentId,
  sessionId,
  depth,
  top,
  stack,
  nextForward,
  titleOf,
  pop,
  forward,
  jumpToAncestor,
  openBrowse,
  copyReference,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  depth: WorkspaceDepthControl;
  top: AppRoute | null;
  stack: readonly AppRoute[];
  nextForward: AppRoute | null;
  titleOf: (route: AppRoute) => string;
  pop: () => void;
  forward: () => void;
  jumpToAncestor: (id: string) => void;
  openBrowse: () => void;
  copyReference: () => void;
}): void {
  // The page header is the shell's; the capability declares the depth, its real
  // ancestry and what leaving it means (#1051, #3971). The label names the
  // depth Back returns to, which for the first push is the capability itself.
  useEffect(() => {
    if (top === null) {
      depth.setPush(null);
      return;
    }
    const below = stack.length > 1 ? stack[stack.length - 2] : null;
    // Nearest-first ancestry, ending with the implicit capability root.
    const ancestors: WorkspaceStackAncestor[] = [
      ...stack.slice(0, -1).reverse().map((route) => ({
        id: routeKey(route),
        title: titleOf(route),
      })),
      CLAUDE_ROOT_ANCESTOR,
    ];
    // The secondary line is the actual path, root-first so it reads like one.
    const subtitle = [...ancestors]
      .reverse()
      .map((ancestor) => ancestor.title)
      .join(' / ');
    depth.setPush({
      title: titleOf(top),
      subtitle,
      backLabel: `Back to ${below === null ? CLAUDE_ROOT_ANCESTOR.title : titleOf(below)}`,
      onLeave: pop,
      ancestors,
      onJumpToAncestor: jumpToAncestor,
    });
  }, [depth, jumpToAncestor, pop, stack, titleOf, top]);

  // A leftward inner swipe may only move to a depth this stack actually left.
  // The shell owns the gesture; this supplies the destination and its name.
  useEffect(() => {
    if (nextForward === null) {
      depth.setForward?.(null);
      return;
    }
    depth.setForward?.({
      title: titleOf(nextForward),
      onActivate: forward,
    });
  }, [depth, forward, nextForward, titleOf]);

  // Browse is capability-local navigation, not a leave: it stays available at
  // every depth, so the user can switch resources without unwinding the stack
  // first. The shell draws the one header control; this supplies the meaning
  // and the icon semantics, never a second bar.
  useEffect(() => {
    if (!agentId || !sessionId) {
      depth.setActions?.(null);
      return;
    }
    depth.setActions?.([
      {
        id: 'browse',
        label: 'Browse',
        ariaLabel: 'Browse Claude',
        icon: 'browse',
        priority: true,
        onActivate: openBrowse,
      },
      // A non-priority action is what makes More appear. It keeps readable
      // text in overflow and never becomes an unlabeled icon control (#3971).
      {
        id: 'copy',
        label: 'Copy reference',
        icon: 'copy',
        onActivate: copyReference,
      },
    ]);
  }, [agentId, copyReference, depth, openBrowse, sessionId]);

  // The capability unmounts with its layer stack; neither the depth, the
  // header actions nor the forward destination may outlive it.
  useEffect(
    () => () => {
      depth.setPush(null);
      depth.setActions?.(null);
      depth.setForward?.(null);
    },
    [depth],
  );
}
