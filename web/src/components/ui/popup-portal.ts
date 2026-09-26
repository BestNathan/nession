import { createContext, useContext } from 'react';

/**
 * Where a popup is mounted, when the layer that opened it supplies a node.
 *
 * A popup escapes the React tree's DOM position: base-ui mounts it on
 * `document.body`, so it inherits nothing from the element the user tapped. On
 * this codebase that includes the `[data-experience]` scope every Experience
 * token is written under — which is why an App menu rendered its items at Web's
 * density (issue 1066). A layer that has a density to preserve hands the popup a
 * container of its own, and the primitive mounts there instead.
 *
 * This is deliberately the *only* thing the primitive learns: a DOM node. Which
 * experience it belongs to, and what attribute that node carries, stays with the
 * layer that owns the scope. "Experience" is not a concept a generic primitive
 * may know about — the same split `capsuleContext` keeps between product meaning
 * and shared UI.
 *
 * `null` means "no owner" — the primitive keeps base-ui's default (`body`),
 * which is what the Web shell wants: it states no floor, and its popups have
 * always resolved from `:root`.
 */
export const PopupPortalContainerContext = createContext<HTMLElement | null>(
  null,
);

/**
 * The container popups opened from this subtree must mount into, or `null` for
 * base-ui's default. Callers pass the result straight through as `container`,
 * translating `null` to `undefined` — base-ui reads an explicit `null` as "wait
 * for the container", which would mount nothing at all.
 */
export function usePopupPortalContainer(): HTMLElement | null {
  return useContext(PopupPortalContainerContext);
}
