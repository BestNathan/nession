/** Shared top-edge tolerance for older-page fetch and pull-to-load (#1190). */
export const TRANSCRIPT_TOP_EDGE_PX = 80;

/**
 * Where the viewport stood against the content, measured while the transcript
 * is in its resting layout. A pull gesture inflates the scroll height (the
 * handle grows and the content translates with the finger), so an anchor
 * measured mid-gesture would restore against phantom pixels: the pull hook
 * captures this at gesture *begin* and hands it to the scroll controller at
 * commit.
 */
export type TranscriptAnchor = { scrollHeight: number; scrollTop: number };

/**
 * Pull distance that fills the ring and commits a load on release.
 *
 * Deliberately a full gesture, not a nudge: at 56 a casual overscroll — three
 * wheel ticks, a short drag — committed a load the user did not ask for. 96
 * asks for intent (four wheel ticks, or a deliberate drag, in the usual
 * pull-to-refresh band of 80–100).
 */
export const TRANSCRIPT_PULL_TRIGGER_PX = 96;

/** Rubber-band headroom past the trigger, so a filled ring can keep pulling. */
export const TRANSCRIPT_PULL_MAX_PX = 120;

export function transcriptIsAtTopEdge(root: HTMLDivElement): boolean {
  return root.scrollTop <= TRANSCRIPT_TOP_EDGE_PX;
}

export function transcriptPullProgress(pullPx: number): number {
  return Math.min(1, pullPx / TRANSCRIPT_PULL_TRIGGER_PX);
}
