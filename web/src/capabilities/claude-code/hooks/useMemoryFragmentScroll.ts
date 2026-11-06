// Deferred fragment scrolling for the Memory reader (#2742).
//
// A link like `topic.md#heading` may point at a file that is still loading, or
// at a heading beyond the loaded chunk. The scroll is therefore a state
// machine keyed by the target path: it runs only after that path's content is
// committed, and gives up with a truthful notice instead of scrolling into
// whatever document happens to be current.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { MemoryState } from './useMemory';
import { headingMatchesFragment } from '../model/memoryLink';

/** A fragment waiting for its target file to render. */
export interface PendingFragment {
  path: string;
  fragment: string;
  /** Re-selecting the same fragment must still run the scroll effect. */
  nonce: number;
}

function findHeading(container: HTMLElement | null, fragment: string): HTMLElement | null {
  if (!container) {
    return null;
  }
  const headings = Array.from(
    container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
  );
  return (
    headings.find((heading) =>
      headingMatchesFragment(heading.textContent ?? '', fragment),
    ) ?? null
  );
}

export function useMemoryFragmentScroll(
  memory: MemoryState,
  contentRef: RefObject<HTMLDivElement | null>,
  previewActive: boolean,
) {
  const [pending, setPending] = useState<PendingFragment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The selection change a link click is expected to cause. Without it, the
  // effect below cannot tell "the user chose another file" from "the hook has
  // not committed the target selection yet" and clears the fragment too early.
  const linkNavigation = useRef<{ target: string; from: string | null } | null>(null);
  const selectedPath = memory.selectedPath;
  const directory = memory.response?.memory_directory ?? '';
  const previousSelection = useRef(selectedPath);

  // A different Session/repository is a different document context: no notice
  // or fragment may survive it.
  useEffect(() => {
    setPending(null);
    setNotice(null);
    linkNavigation.current = null;
  }, [directory]);

  // A different selected file drops a fragment aimed at the previous one. The
  // reader sets `pending` before the hook updates `selectedPath`, so this only
  // clears a target the user did not navigate to.
  useEffect(() => {
    if (!pending) {
      linkNavigation.current = null;
      return;
    }
    const navigation = linkNavigation.current;
    if (!navigation) {
      if (pending.path !== selectedPath) {
        setPending(null);
        setNotice(null);
      }
      return;
    }
    if (selectedPath === navigation.from) {
      return;
    }
    linkNavigation.current = null;
    if (selectedPath !== pending.path) {
      setPending(null);
      setNotice(null);
    }
  }, [pending, selectedPath]);

  /** Record that this fragment is expected to select `target` from `from`. */
  const beginLinkNavigation = useCallback((target: string, from: string | null) => {
    linkNavigation.current = { target, from };
  }, []);

  // A notice belongs to the file the user was reading. Clear it when a list
  // selection changes; a fragment notice does not change `selectedPath`, so it
  // survives the state update that produced it.
  useEffect(() => {
    if (previousSelection.current === selectedPath) {
      return;
    }
    previousSelection.current = selectedPath;
    if (!pending) {
      setNotice(null);
    }
  }, [pending, selectedPath]);

  // Scroll only after the target path's own content is committed. A heading
  // missing from a partially loaded file is reported, never guessed at.
  useEffect(() => {
    if (!pending || !previewActive) {
      return;
    }
    if (
      selectedPath !== pending.path ||
      memory.loadedPath !== pending.path ||
      memory.readLoading
    ) {
      return;
    }
    if (memory.readError) {
      setPending(null);
      return;
    }
    const heading = findHeading(contentRef.current, pending.fragment);
    if (heading) {
      heading.scrollIntoView?.({ block: 'start' });
      setNotice(null);
      setPending(null);
      return;
    }
    if (memory.hasMore) {
      setNotice(
        `The heading “${pending.fragment}” is not in the loaded part of this file. ` +
          'Use Load more to continue; the reader will scroll to it when it arrives.',
      );
      return;
    }
    setNotice(`The heading “${pending.fragment}” was not found in this file.`);
    setPending(null);
  }, [
    pending,
    previewActive,
    contentRef,
    selectedPath,
    memory.loadedPath,
    memory.readLoading,
    memory.readError,
    memory.hasMore,
    memory.content,
  ]);

  return { pending, setPending, notice, setNotice, beginLinkNavigation };
}
