/**
 * The App experience's typography roles, as class strings (#1073).
 *
 * This is the App's composition boundary for type. A component that renders App
 * chrome picks a *role* here instead of a Tailwind size literal, so "which size"
 * is answered once in `design/tokens/experience/app.json` rather than per
 * component — the failure #1073 records is eight unrelated values accumulated
 * from Web shell metrics, primitive defaults and component-local literals.
 *
 * **Why the class strings live here rather than at each call site.** For an
 * App-owned surface the two are equivalent, but the shared surfaces need one
 * place that says which experience a class belongs to: `--typography-title-size`
 * and `--typography-body-size` are emitted only under `[data-experience="app"]`,
 * and `nession/no-cross-experience-token` asks a binding to declare that fact in
 * its name. The `…App…` naming is that declaration, and it is what the existing
 * `capsuleShellAppOuterClass` does for the capsule.
 *
 * **One-sided roles are why every role is exported, not only the two.** `title`
 * and `body` exist on App only, so they are App-scoped by construction. The
 * other four also exist at `:root` (Web states its own size for each), so a
 * class here is *the App's density for a shared role* — outside the App
 * experience the same string resolves to Web's value. Exporting all six as one
 * vocabulary keeps a caller from having to know which is which, and keeps the
 * role list in one place for #1051 to consume.
 *
 * **Not for work surfaces.** xterm reads `experience.app.terminal` and
 * CodeMirror reads `workspace.editorFontSize`; markdown document typography is
 * the document's own. Those are the workload's rendering, not chrome, and #1073
 * keeps them out of this scale deliberately.
 *
 * Size only. Family (mono/sans) and weight stay with the text: a path is mono at
 * the header's size, not mono *because* it is smaller.
 */

/** The page's own name: Session title, Workspace tool title, pushed detail title. */
export const titleAppClass = 'text-[length:var(--typography-title-size)]';

/** The row the surface exists for: a Session name, a file name. */
export const primaryAppClass = 'text-[length:var(--typography-primary-size)]';

/** Controls and ordinary actions — a control's size follows its job, not its primitive. */
export const bodyAppClass = 'text-[length:var(--typography-body-size)]';

/** Supporting but fully readable: a node row under a section label. */
export const secondaryAppClass = 'text-[length:var(--typography-secondary-size)]';

/** Quiet: recency, counts, section labels, the footer's service state. */
export const metadataAppClass = 'text-[length:var(--typography-metadata-size)]';

/** Chrome-side technical identity: the path above the tree, the file header. */
export const codeAppClass = 'text-[length:var(--typography-code-size)]';
