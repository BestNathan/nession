/** Shared top-edge tolerance for older-page fetch and pull-to-load (#1190). */
export const TRANSCRIPT_TOP_EDGE_PX = 80;

/** Pull distance that fills the ring and commits a load on release. */
export const TRANSCRIPT_PULL_TRIGGER_PX = 56;

export const TRANSCRIPT_PULL_MAX_PX = 80;

export function transcriptIsAtTopEdge(root: HTMLDivElement): boolean {
  return root.scrollTop <= TRANSCRIPT_TOP_EDGE_PX;
}

export function transcriptPullProgress(pullPx: number): number {
  return Math.min(1, pullPx / TRANSCRIPT_PULL_TRIGGER_PX);
}
