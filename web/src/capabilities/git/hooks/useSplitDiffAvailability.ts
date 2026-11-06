import { useLayoutEffect, useState } from 'react';

/**
 * Below this the two diff columns get less width than the line numbers and
 * indentation they already need, so the renderer would present a split that is
 * only "split" by name. The threshold is about the diff pane, not the viewport:
 * the same browser can be on a phone-width pane or inside a wide App shell.
 */
export const SPLIT_DIFF_MIN_WIDTH = 640;

/**
 * Whether the diff pane has room for the split presentation.
 *
 * The App/phone presentation is not a different product, only less width, so
 * the decision is measured where the diff is actually drawn. When the pane is
 * narrow the control is not offered at all; offering a disabled two-column
 * toggle would be a control the reader can see but cannot use.
 */
export function useSplitDiffAvailability(element: HTMLElement | null): boolean {
  const [available, setAvailable] = useState(false);

  useLayoutEffect(() => {
    if (!element) {
      setAvailable(false);
      return;
    }

    const update = () => setAvailable(element.clientWidth >= SPLIT_DIFF_MIN_WIDTH);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return available;
}
