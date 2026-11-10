# Layout Composition & Consistency Lab — Issue #3194

**Owner:** [Requirement #3194](https://github.com/BestNathan/nession/issues/3194)  
**Published path:** \`layout-consistency-3194/index.html\` on orphan \`prototype\` branch  
**Direct HTML candidate:** https://bestnathan.github.io/nession/prototypes/layout-consistency-3194/index.html  
**Gallery:** https://bestnathan.github.io/nession/#/prototypes  
**Source pin:** recorded on the Issue after atomic publication; no source claim based only on a moving branch ref.

## Question and product decision

A React class combination can be legal Tailwind yet violate a stable Workspace host/content layout contract. We compare an **illustrative unmanaged variant** and a **candidate contract-driven layout** for three content families, within the same outer Nession Web/App ownership tree.

- **Experience owner:** WebLayout → Sidebar + ShellMain → WorkspaceShell → capability content; AppLayout/AppLayers → WorkspacePanel/AppPageHeader (single Back/title) → WorkspaceShell → content. Nession owns the frame; the capability does not own it.
- **Semantic layout:** Work content width, form field/control role, scroll-owner, Files master/detail composition. Reuse existing canonical patterns and #3142 overlay instead of rebuilding overlays.
- **Local mechanism:** flex/grid/min-w-0/min-h-0 remain valid for internal composition without reasserting host geometry.
- **Open decision:** the minimal proven number of reusable layout recipes and which existing consumers migrate first; do not infer a new universal DSL from this mock.

## Scenario / mocked user flow

1. Start at Web 1180 and **Unified contract / Detail / Normal**. The current Project detail occupies the Workspace surface. Toggle **Local classes** to show a competing local two-column width/gap.
2. Switch **Form**; the contract variant keeps common control sizing and body/action placement. Local classes make controls unequal and an over-wide form. Toggle **Long** to add overflowing paths and repeated content; observe actual mock DOM metrics below the preview.
3. Switch **Files**; the contract variant uses bounded tree+viewer split on Web; the local variant exceeds its available width.
4. Switch **App 390 / 375**. Contract layout stacks detail and form and shows Files list → file preview as a pushed depth under **one** App header. Local classes keep the wide desktop geometry. Use back to reach Sessions; reopen Workspace; switch App → Web again.
5. Try keyboard tab focus on controls, product actions, reset. The external readout reports measured width, overflow and CSS overflow mode from **this mock**, not actual shipping Nession.

## Fidelity / baseline and deviations

- **Mock-only data and actions:** Project 'edge-platform', Agent 'edge-node-01', Sessions, Files and operation submit are deterministic local fixtures. No backend/API/Agent request, no storage and no production change.
- **Product semantic baseline:** main's \`web/src/app/experiences/web/WebLayout.tsx\`, \`.../app/AppLayers.tsx\`, \`web/src/app/workspace/WorkspaceShell.tsx\`, \`docs/design/composition.md\`, \`docs/design/design-system/patterns.md\`, \`docs/design/design-system/contracts.md\`, \`design/generated/web.css\`. No new global toolbar, no nested capability shell and no duplicate App Back.
- **Visual limits:** standalone CSS is an approximation of current light Nession workspace/controls, not a byte-identical shadcn render or current production screenshot. Desktop Sidebar and Workspace capsule are deliberately simplified, Files/Project sample data are representative not live. The unmanaged side deliberately breaks target layout, not an assertion that identical defects occur on every production screen.
- **Viewport:** external shared \`prototype-frame-2758\` frame; simulated 1180/1024 Web and 390/375 App at nominal 1:1 CSS pixels. No CSS scale or zoom; the stage can scroll horizontally without hiding either edge.
- **Browser / publication verification:** Not yet independently verified at the time of initial authoring; update Issue only with actual evidence. A published Pages URL requires HTML response and \`prototypes/manifest.json\` pinned SHA readback.
- **Production Acceptance:** absolutely not established by a mock. Source-aligned Chromium/Playwright Cases and canonical Gate negative fixtures belong to production implementation.

## Static smoke recipe

Open \`index.html\` from an HTTP static server in the prototype branch so sibling \`../prototype-frame-2758/frame.css\` and \`frame.js\` load. Ensure all three product surfaces render; exercise both modes, Web/App switches and long content. Inspect \`read-overflow\`, \`read-scroll\`, external 1:1 size readout, and one App header. Check Browser console and resource responses. Exact commands and observed browser evidence should be appended to Issue when available.

## Non-goals

No production code changes, no production gate or token migration, no full-shell visual parity claim, no third-party network requests, no app authorization, no data persistence. 