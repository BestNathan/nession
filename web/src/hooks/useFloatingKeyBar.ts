import { useState, useRef, useCallback, useEffect } from 'react';

const AUTO_HIDE_MS = 3000;

export interface FloatingKeyBarState {
  visible: boolean;
  dismissed: boolean;
  show: () => void;
  onActivity: () => void;
  dismiss: () => void;
  restore: () => void;
  forceHide: () => void;
}

export function useFloatingKeyBar(): FloatingKeyBarState {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setVisible(false);
    }, AUTO_HIDE_MS);
  }, [clearTimer]);

  const show = useCallback(() => {
    setVisible(true);
    setDismissed(false);
    startTimer();
  }, [startTimer]);

  const onActivity = useCallback(() => {
    if (dismissed) {
      return;
    }
    startTimer();
  }, [dismissed, startTimer]);

  const dismiss = useCallback(() => {
    clearTimer();
    setVisible(false);
    setDismissed(true);
  }, [clearTimer]);

  const restore = useCallback(() => {
    setDismissed(false);
    setVisible(true);
    startTimer();
  }, [startTimer]);

  const forceHide = useCallback(() => {
    clearTimer();
    setVisible(false);
  }, [clearTimer]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return { visible, dismissed, show, onActivity, dismiss, restore, forceHide };
}
