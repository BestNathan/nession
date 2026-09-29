import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
} from 'react';

import { TRANSCRIPT_TOP_EDGE_PX, type TranscriptAnchor } from './transcriptScrollConstants';

const BOTTOM_AFFINITY_PX = 48;

type OlderFetchRefs = {
  olderFetchArmedRef: MutableRefObject<boolean>;
  pendingAnchorRef: MutableRefObject<TranscriptAnchor | null>;
  loadOlderRef: MutableRefObject<() => boolean>;
};

function requestOlderPage(
  el: HTMLDivElement,
  refs: OlderFetchRefs,
  gestureAnchor: TranscriptAnchor | null,
): void {
  // A pull commit hands over the anchor from gesture begin — at commit time
  // the layout is inflated by the pull itself. Every other path measures
  // here, against a resting layout.
  refs.pendingAnchorRef.current =
    gestureAnchor ?? { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
  refs.olderFetchArmedRef.current = true;
  // The engagement answer must come back synchronously: inferring it from
  // `loadingOlder` one task later races React's flush of the spinner render,
  // which discrete events (pointerup) run before a microtask but continuous
  // events (wheel) defer to the scheduler — the pull would then disarm a
  // fetch that is genuinely on its way and lose the anchor.
  const engaged = refs.loadOlderRef.current();
  if (!engaged) {
    refs.olderFetchArmedRef.current = false;
    refs.pendingAnchorRef.current = null;
  }
}

/**
 * Scroll controller for ConversationTranscript (#1190): initial bottom placement,
 * top-driven older loads, prepend anchor preservation, live-poll bottom affinity.
 */
export function useTranscriptScroll({
  conversationId,
  itemCount,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: {
  conversationId: string | null;
  itemCount: number;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const followingLatestRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const pendingAnchorRef = useRef<TranscriptAnchor | null>(null);
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const loadingOlderRef = useRef(loadingOlder);
  loadingOlderRef.current = loadingOlder;
  const olderFetchArmedRef = useRef(false);
  const itemCountRef = useRef(0);

  useEffect(() => {
    if (!loadingOlder) {
      olderFetchArmedRef.current = false;
    }
  }, [loadingOlder]);

  /**
   * Conversation switches reset the scroll bookkeeping — but the reset must
   * not be a passive effect. `conversationId` starts `null` while the first
   * page loads and becomes a real id in the same commit that brings the first
   * items; a passive reset would then run *after* the layout effect below had
   * already marked the initial scroll done, leaving `initialScrollDoneRef`
   * stuck `false` and every older-page request rejected — which is exactly
   * what killed pull-to-load on a freshly opened conversation. The layout
   * effect owns scroll state, so the reset lives there, synchronously before
   * the bookkeeping it clears.
   */
  const conversationIdRef = useRef(conversationId);

  const requestIfReady = useCallback(
    (requireTopEdge: boolean, gestureAnchor: TranscriptAnchor | null = null) => {
      const el = scrollRef.current;
      if (
        !el ||
        !initialScrollDoneRef.current ||
        loadingOlderRef.current ||
        olderFetchArmedRef.current ||
        !hasMoreRef.current ||
        (requireTopEdge && el.scrollTop > TRANSCRIPT_TOP_EDGE_PX)
      ) {
        return;
      }
      requestOlderPage(
        el,
        {
          olderFetchArmedRef,
          pendingAnchorRef,
          loadOlderRef,
        },
        gestureAnchor,
      );
    },
    [],
  );

  const maybeLoadOlderNearTop = useCallback(() => {
    requestIfReady(true);
  }, [requestIfReady]);

  const loadOlderFromPull = useCallback(
    (gestureAnchor: TranscriptAnchor | null = null) => {
      requestIfReady(false, gestureAnchor);
    },
    [requestIfReady],
  );

  const updateFollowingLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    followingLatestRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_AFFINITY_PX;
  }, []);

  useLayoutEffect(() => {
    if (conversationIdRef.current !== conversationId) {
      conversationIdRef.current = conversationId;
      followingLatestRef.current = true;
      initialScrollDoneRef.current = false;
      pendingAnchorRef.current = null;
      itemCountRef.current = 0;
      olderFetchArmedRef.current = false;
    }
    const el = scrollRef.current;
    if (!el || itemCount === 0) {
      return;
    }

    // The anchor is meaningful only against the render the older page lands
    // in. The intermediate spinner render (`loadingOlder: true`) also re-runs
    // this effect — the handle swaps for a spinner and the scroll height
    // *shrinks* — so consuming the anchor there would restore against the
    // wrong content and leave the actual prepend render anchorless, jumping
    // the viewport to the new items.
    if (pendingAnchorRef.current && !loadingOlder) {
      const anchor = pendingAnchorRef.current;
      const delta = el.scrollHeight - anchor.scrollHeight;
      el.scrollTop = anchor.scrollTop + delta;
      pendingAnchorRef.current = null;
      itemCountRef.current = itemCount;
      maybeLoadOlderNearTop();
      return;
    }

    const grew = itemCount > itemCountRef.current;
    itemCountRef.current = itemCount;

    if (!initialScrollDoneRef.current) {
      el.scrollTop = el.scrollHeight;
      initialScrollDoneRef.current = true;
      followingLatestRef.current = true;
      maybeLoadOlderNearTop();
      return;
    }

    if (grew && followingLatestRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [conversationId, hasMore, itemCount, loadingOlder, maybeLoadOlderNearTop]);

  const onScroll = () => {
    updateFollowingLatest();
  };

  return {
    scrollRef,
    topSentinelRef,
    onScroll,
    captureAnchorAndLoadOlder: maybeLoadOlderNearTop,
    loadOlderFromPull,
  };
}
