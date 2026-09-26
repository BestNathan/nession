import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PopupPortalContainerContext } from '@/components/ui/popup-portal';

/**
 * The container the App's popups mount into (issue 1066).
 *
 * The App experience is a *scope*, and `app-layer-root` is the element that
 * states it: `data-experience="app"` is what the generated CSS rewrites the
 * Experience tokens under. Anything rendered as a descendant inherits them —
 * but a popup is not a descendant. base-ui mounts menus and popovers on
 * `document.body`, so a menu opened from an App control resolved `--control-sm`
 * to Web's 28px and drew 28px rows inside an experience whose floor is 44px.
 * Measured on the session-row `…` menu (`184×28`), and identical on the `+`
 * capability menu that had been shipping that way.
 *
 * So the scope needs a container of its own, and it has to carry the attribute
 * itself rather than inherit it: the node is a child of `<body>`, a sibling of
 * `#root`, and nothing above it says "app".
 *
 * **Why `document.body` and not a node inside `app-layer-root`.** The layer root
 * is `overflow: hidden`, and base-ui positions its popup `absolute` — a menu
 * portalled in there would be clipped by the very element it is anchored to.
 * The layer wrappers also carry `transform`, which re-parents a positioned
 * descendant. A child of `<body>` is outside every clipping and containing block
 * the App happens to have, which is the same property that made base-ui pick
 * `body` in the first place; what changes is only what the node *says*, not
 * where it is.
 *
 * The host renders unconditionally and is empty until a popup mounts into it, so
 * the container exists before anything can ask for it: base-ui reads the
 * `container` prop once, when the popup mounts, and a node assigned later would
 * never be re-read. That is why this holds state rather than a ref.
 */
export function AppPopupPortal({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  return (
    <PopupPortalContainerContext.Provider value={container}>
      {children}
      {createPortal(
        <div
          ref={setContainer}
          data-testid="app-popup-portal"
          data-experience="app"
        />,
        document.body,
      )}
    </PopupPortalContainerContext.Provider>
  );
}
