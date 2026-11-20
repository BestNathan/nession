import { createContext, useContext } from 'react';
import type { InnerSwipeAction } from '@/app/experiences/app/swipeGesture';

/**
 * The live inner Workspace stack motion (#3971).
 *
 * `AppLayers` is the single gesture coordinator. When a contact resolves to an
 * inner Pop/Forward, the coordinator publishes the frozen operation and the
 * page's live offset here; the Workspace host translates the header and content
 * region together, while the Capability Capsule stays at its own geometry. The
 * Workspace layer's opaque background is outside that frame, so the Terminal is
 * never exposed by an internal-depth gesture.
 */
export interface AppInnerStackMotion {
  action: InnerSwipeAction | null;
  /** Signed live offset; positive is a rightward (Pop) movement. */
  offset: number;
  /** True while the page animates back to rest after release. */
  settling: boolean;
  /**
   * Report that the rendered return transition finished. The coordinator uses
   * it to finish the settle from real motion; its timer remains the bounded
   * fallback (#4185). Null when no settle is running.
   */
  onSettled: (() => void) | null;
}

const REST: AppInnerStackMotion = {
  action: null,
  offset: 0,
  settling: false,
  onSettled: null,
};

export const AppInnerStackMotionContext = createContext<AppInnerStackMotion>(REST);

export function useAppInnerStackMotion(): AppInnerStackMotion {
  return useContext(AppInnerStackMotionContext);
}
