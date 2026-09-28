import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

const BOTTOM_AFFINITY_PX = 48;
const TOP_LOAD_THRESHOLD_PX = 80;

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
  const itemCountRef = useRef(0);

  useEffect(() => {
    followingLatestRef.current = true;
    initialScrollDoneRef.current = false;
    pendingAnchorRef.current = null;
    itemCountRef.current = 0;
  }, [conversationId]);

  const captureAnchorAndLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingOlder || !hasMore) {
      return;
    }
    pendingAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    loadOlderRef.current();
  }, [hasMore, loadingOlder]);

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
      return;
    }

    const grew = itemCount > itemCountRef.current;
    itemCountRef.current = itemCount;

    if (!initialScrollDoneRef.current) {
      el.scrollTop = el.scrollHeight;
      initialScrollDoneRef.current = true;
      followingLatestRef.current = true;
      return;
    }

    if (grew && followingLatestRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [itemCount]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (typeof IntersectionObserver === 'undefined' || !root || !sentinel || !hasMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting || !initialScrollDoneRef.current || loadingOlder) {
          return;
        }
        captureAnchorAndLoadOlder();
      },
      { root, rootMargin: `${TOP_LOAD_THRESHOLD_PX}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [captureAnchorAndLoadOlder, conversationId, hasMore, loadingOlder]);

  const onScroll = () => {
    updateFollowingLatest();
    const el = scrollRef.current;
    if (
      !el ||
      !initialScrollDoneRef.current ||
      loadingOlder ||
      !hasMore ||
      el.scrollTop > TOP_LOAD_THRESHOLD_PX
    ) {
      return;
    }
    captureAnchorAndLoadOlder();
  };

  return { scrollRef, topSentinelRef, onScroll, captureAnchorAndLoadOlder };
}
