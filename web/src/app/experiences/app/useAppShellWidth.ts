import { useEffect, useState, type RefObject } from 'react';

export const APP_SHELL_FALLBACK_WIDTH_PX = 375;

/**
 * The shell's laid-out width, observed rather than assumed.
 *
 * The pager measures its edge band and commit threshold from this element
 * (#1081, #2724); a `window.innerWidth` would be wrong for an inset App. The
 * fallback is only used before the first layout read.
 */
export function useAppShellWidth(rootRef: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(APP_SHELL_FALLBACK_WIDTH_PX);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) {
      return;
    }

    const measure = () => {
      const next = el.getBoundingClientRect().width;
      if (next > 0) {
        setWidth(next);
      }
    };

    measure();

    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [rootRef]);

  return width;
}
