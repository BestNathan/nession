import { useEffect, useState } from 'react';

export interface VisualViewportState {
  height: number;
  offsetTop: number;
  width: number;
  isKeyboardOpen: boolean;
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() => ({
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
    offsetTop: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    isKeyboardOpen: false,
  }));

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    // Capture the instance so the cleanup uses the same reference it subscribed
    // to (window.visualViewport may be torn down by the time the effect cleans up).
    const vv = window.visualViewport;
    const handler = () => {
      setState({
        height: vv.height,
        offsetTop: vv.offsetTop,
        width: vv.width,
        isKeyboardOpen: vv.height < window.innerHeight * 0.75,
      });
    };

    vv.addEventListener('resize', handler);
    vv.addEventListener('scroll', handler);
    handler();

    return () => {
      vv.removeEventListener('resize', handler);
      vv.removeEventListener('scroll', handler);
    };
  }, []);

  return state;
}
