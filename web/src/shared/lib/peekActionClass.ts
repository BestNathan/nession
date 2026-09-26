/**
 * The appearance of a Peek's own action — "Open in Workspace", and whatever a
 * capability offers beside it (#1046).
 *
 * ## Why this is in `shared/` and not with the rest of the capsule's styles
 *
 * `#1046` asks the Peek host to "expose a small set of stable primitives … 
 * rather than forcing one universal layout", and the action this replaces was
 * drawn by the host. It cannot live there: `nession/no-reverse-imports` lets a
 * capability import only from `platform` and `shared`, so a primitive the host
 * owns is one no capability can render. Measured, not assumed — the first
 * attempt imported it from `product/terminal/capsule` and eslint refused with
 * `capabilities cannot import from product`.
 *
 * `shared/` is the only layer beneath both, which makes this the only home the
 * rule leaves. It is not "generic" in the sense the rest of `shared/` is, and
 * that is worth knowing when the next Peek primitive is added: the requirement's
 * stable primitive set has a placement constraint it does not mention, and this
 * file is where that lands.
 *
 * One class rather than one per capability, so two Peeks that both offer the
 * action look the same and the third does not invent its own.
 */
export const capsulePeekActionClass =
  'rounded px-[length:var(--terminal-capsule-projection-item-pad-x)] font-medium text-foreground transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
