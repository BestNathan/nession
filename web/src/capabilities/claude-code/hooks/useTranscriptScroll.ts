import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const BOTTOM_AFFINITY_PX = 48;
const TOP_LOAD_THRESHOLD_PX = 80;

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
    { root, rootMargin: `${TOP_LOAD_THRESHOLD_PX}px 0px 0px 0px`, threshold: 0 },
  );
  observer.observe(sentinel);
  return () => observer.disconnect();
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
      el.scrollTop > TOP_LOAD_THRESHOLD_PX
    ) {
      return;
    }
    pendingAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    olderFetchArmedRef.current = true;
    loadOlderRef.current();
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
      maybeLoadOlderNearTop(); // short first page: IO may have fired too early (#1190)
      return;
    }

    if (grew && followingLatestRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [itemCount, maybeLoadOlderNearTop]);

  useLayoutEffect(() => {
    if (loadingOlder || !hasMore || itemCount === 0) {
      return;
    }
    maybeLoadOlderNearTop();
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
    maybeLoadOlderNearTop();
  };

  return {
    scrollRef,
    topSentinelRef,
    onScroll,
    captureAnchorAndLoadOlder: maybeLoadOlderNearTop,
  };
}
