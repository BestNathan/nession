import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react';

import { TRANSCRIPT_TOP_EDGE_PX } from './transcriptScrollConstants';

const BOTTOM_AFFINITY_PX = 48;

type TopSentinelObserverArgs = {
  root: HTMLDivElement;
  sentinel: HTMLDivElement;
  initialScrollDoneRef: RefObject<boolean>;
  loadingOlderRef: RefObject<boolean>;
  onNearTop: () => void;
};

function installTopSentinelObserver(args: TopSentinelObserverArgs): () => void {
  const { root, sentinel, initialScrollDoneRef, loadingOlderRef, onNearTop } = args;
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting || !initialScrollDoneRef.current || loadingOlderRef.current) {
        return;
      }
      onNearTop();
    },
    { root, rootMargin: `${TRANSCRIPT_TOP_EDGE_PX}px 0px 0px 0px`, threshold: 0 },
  );
  observer.observe(sentinel);
  return () => observer.disconnect();
}

type OlderFetchRefs = {
  loadingOlderRef: RefObject<boolean>;
  olderFetchArmedRef: MutableRefObject<boolean>;
  pendingAnchorRef: MutableRefObject<{ scrollHeight: number; scrollTop: number } | null>;
  loadOlderRef: MutableRefObject<() => void>;
};

function requestOlderPage(el: HTMLDivElement, refs: OlderFetchRefs): void {
  refs.pendingAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
  refs.loadOlderRef.current();
  queueMicrotask(() => {
    if (refs.loadingOlderRef.current) {
      refs.olderFetchArmedRef.current = true;
    } else {
      refs.pendingAnchorRef.current = null;
    }
  });
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
  onLoadOlder: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const followingLatestRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const pendingAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
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

  useEffect(() => {
    followingLatestRef.current = true;
    initialScrollDoneRef.current = false;
    pendingAnchorRef.current = null;
    itemCountRef.current = 0;
    olderFetchArmedRef.current = false;
  }, [conversationId]);

  /** Load the next older page when the viewport is already near the top sentinel. */
  const maybeLoadOlderNearTop = useCallback(() => {
    const el = scrollRef.current;
    if (
      !el ||
      !initialScrollDoneRef.current ||
      loadingOlderRef.current ||
      olderFetchArmedRef.current ||
      !hasMoreRef.current ||
      el.scrollTop > TRANSCRIPT_TOP_EDGE_PX
    ) {
      return;
    }
    requestOlderPage(el, {
      loadingOlderRef,
      olderFetchArmedRef,
      pendingAnchorRef,
      loadOlderRef,
    });
  }, []);

  const updateFollowingLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    followingLatestRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_AFFINITY_PX;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || itemCount === 0) {
      return;
    }

    if (pendingAnchorRef.current) {
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

    if (!loadingOlder && hasMore) {
      maybeLoadOlderNearTop();
    }

    if (grew && followingLatestRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [hasMore, itemCount, loadingOlder, maybeLoadOlderNearTop]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (typeof IntersectionObserver === 'undefined' || !root || !sentinel || !hasMore) {
      return;
    }
    return installTopSentinelObserver({
      root,
      sentinel,
      initialScrollDoneRef,
      loadingOlderRef,
      onNearTop: maybeLoadOlderNearTop,
    });
  }, [conversationId, hasMore, loadingOlder, maybeLoadOlderNearTop]);

  const onScroll = () => {
    updateFollowingLatest();
  };

  return {
    scrollRef,
    topSentinelRef,
    onScroll,
    captureAnchorAndLoadOlder: maybeLoadOlderNearTop,
  };
}
