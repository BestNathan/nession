import { useCallback, useMemo, useRef, useState } from 'react';
import { useCommandHistory } from '@/product/terminal/hooks/useCommandHistory';
import { layoutFromLineCount } from '@/product/terminal/capsule/measure/layoutFromLineCount';
import type {
  CapsulePopoverId,
  ComposerLayout,
} from '@/product/terminal/capsule/types';

export interface UseCapsuleStateOptions {
  sendText: (text: string) => void;
  disabled?: boolean;
}

export interface CapsuleState {
  inputValue: string;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  composerLayout: ComposerLayout;
  setComposerLayout: (layout: ComposerLayout) => void;
  applyLineCount: (lineCount: number) => void;
  openPopover: CapsulePopoverId | null;
  setHistoryOpen: (open: boolean) => void;
  historyOpen: boolean;
  /**
   * Whether the upper Context Capsule is up (#1347 SC-41).
   *
   * Its own flag rather than a `CapsulePopoverId`: the history popover is a
   * popover anchored to a control, while this is a second *Capsule* in the dock.
   * It is mutually exclusive with the popover all the same — two floating
   * surfaces over one terminal is the shape the mockup's own note calls out —
   * so opening either closes the other.
   */
  contextOpen: boolean;
  setContextOpen: (open: boolean) => void;
  disabled: boolean;
  send: () => void;
  copyInput: () => Promise<void>;
}

export function useCapsuleState({
  sendText,
  disabled = false,
}: UseCapsuleStateOptions): CapsuleState {
  const [inputValue, setInputValue] = useState('');
  const [composerLayout, setComposerLayoutState] = useState<ComposerLayout>('flat');
  const [openPopover, setOpenPopover] = useState<CapsulePopoverId | null>(null);
  const [contextOpen, setContextOpenState] = useState(false);
  const layoutRef = useRef(composerLayout);
  layoutRef.current = composerLayout;
  const { addEntry } = useCommandHistory();

  const setComposerLayout = useCallback((layout: ComposerLayout) => {
    if (layout !== layoutRef.current) {
      setComposerLayoutState(layout);
    }
  }, []);

  const setHistoryOpen = useCallback((open: boolean) => {
    setOpenPopover(open ? 'history' : null);
    if (open) {
      setContextOpenState(false);
    }
  }, []);

  const setContextOpen = useCallback((open: boolean) => {
    setContextOpenState(open);
    if (open) {
      setOpenPopover(null);
    }
  }, []);

  const applyLineCount = useCallback(
    (lineCount: number) => {
      setComposerLayout(layoutFromLineCount(lineCount));
    },
    [setComposerLayout],
  );

  const send = useCallback(() => {
    const text = inputValue.trim();
    if (!text) {
      return;
    }
    sendText(`${text}\r`);
    addEntry(text);
    setInputValue('');
    setComposerLayout('flat');
    setHistoryOpen(false);
  }, [addEntry, inputValue, sendText, setComposerLayout, setHistoryOpen]);

  const copyInput = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inputValue);
    } catch {
      // clipboard unavailable
    }
  }, [inputValue]);

  return useMemo(
    () => ({
      inputValue,
      setInputValue,
      composerLayout,
      setComposerLayout,
      applyLineCount,
      openPopover,
      setHistoryOpen,
      historyOpen: openPopover === 'history',
      contextOpen,
      setContextOpen,
      disabled,
      send,
      copyInput,
    }),
    [
      applyLineCount,
      composerLayout,
      contextOpen,
      copyInput,
      disabled,
      inputValue,
      openPopover,
      send,
      setComposerLayout,
      setContextOpen,
      setHistoryOpen,
    ],
  );
}

export type CapsuleStateValue = ReturnType<typeof useCapsuleState>;
