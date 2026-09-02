import { useCallback, useMemo, useRef, useState } from 'react';
import { useCommandHistory } from '@/hooks/useCommandHistory';
import { layoutFromLineCount } from '@/session-first/capsule/measure/layoutFromLineCount';
import type {
  CapsuleMode,
  CapsulePopoverId,
  ComposerLayout,
} from '@/session-first/capsule/types';

export interface UseCapsuleStateOptions {
  sendText: (text: string) => void;
  disabled?: boolean;
  mode?: CapsuleMode;
  onModeChange?: (mode: CapsuleMode) => void;
  allowLayoutChanges?: boolean;
}

export interface CapsuleState {
  inputValue: string;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  composerLayout: ComposerLayout;
  setComposerLayout: (layout: ComposerLayout) => void;
  applyLineCount: (lineCount: number) => void;
  openPopover: CapsulePopoverId | null;
  setHistoryOpen: (open: boolean) => void;
  setCommandsOpen: (open: boolean) => void;
  historyOpen: boolean;
  commandsOpen: boolean;
  mode: CapsuleMode;
  onModeChange?: (mode: CapsuleMode) => void;
  disabled: boolean;
  send: () => void;
  pasteIntoInput: () => void;
  copyInput: () => Promise<void>;
}

export function useCapsuleState({
  sendText,
  disabled = false,
  mode = 'input',
  onModeChange,
  allowLayoutChanges = true,
}: UseCapsuleStateOptions): CapsuleState {
  const [inputValue, setInputValue] = useState('');
  const [composerLayout, setComposerLayoutState] = useState<ComposerLayout>('flat');
  const [openPopover, setOpenPopover] = useState<CapsulePopoverId | null>(null);
  const layoutRef = useRef(composerLayout);
  layoutRef.current = composerLayout;
  const { addEntry } = useCommandHistory();

  const setComposerLayout = useCallback(
    (layout: ComposerLayout) => {
      if (!allowLayoutChanges) {
        return;
      }
      if (layout !== layoutRef.current) {
        setComposerLayoutState(layout);
      }
    },
    [allowLayoutChanges],
  );

  const setHistoryOpen = useCallback((open: boolean) => {
    setOpenPopover(open ? 'history' : null);
  }, []);

  const setCommandsOpen = useCallback((open: boolean) => {
    setOpenPopover(open ? 'commands' : null);
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
    setCommandsOpen(false);
  }, [addEntry, inputValue, sendText, setCommandsOpen, setComposerLayout, setHistoryOpen]);

  const pasteIntoInput = useCallback(() => {
    if (!navigator.clipboard?.readText) {
      return;
    }
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          setInputValue((prev) => prev + text);
        }
      })
      .catch(() => undefined);
  }, []);

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
      setCommandsOpen,
      historyOpen: openPopover === 'history',
      commandsOpen: openPopover === 'commands',
      mode,
      onModeChange,
      disabled,
      send,
      pasteIntoInput,
      copyInput,
    }),
    [
      applyLineCount,
      composerLayout,
      copyInput,
      disabled,
      inputValue,
      mode,
      onModeChange,
      openPopover,
      pasteIntoInput,
      send,
      setCommandsOpen,
      setComposerLayout,
      setHistoryOpen,
    ],
  );
}

export type CapsuleStateValue = ReturnType<typeof useCapsuleState>;
