# Pages ownership — public observatory (Issue #1782)

This is a standalone, anonymous static project. All application code, visual language, design tokens, typography, CSS, navigation, icons and components live under \`pages/\`. There is **no dependency on \`web/\`**: no imports, copied components/tokens/styles, runtime auth, session state or WebSockets. It is intentionally a distinct visual design.

The UI is a React 19 + TypeScript Vite MPA with its own lockfile (`pages/package-lock.json`) and minimal runtime dependencies (`react`, `react-dom`). Source ownership:

- `src/app/` — both entrypoints, typed hash router, canonical navigation inventory, React resource-state wiring and feature-local UI state;
- `src/layouts/` — the Pages shell (header/navigation/main/footer);
- `src/components/` — shared cards, sections, links and empty/loading states;
- `src/features/{overview,agents,collaboration,workflows,knowledge,documents/{protocol,mcp},prototypes,repository,evidence}/` — business UI and pure feature transforms;
- `src/data/` — public snapshot contracts, runtime validation and the independent per-source loaders;
- `src/lib/` — formatting and safe link/Markdown helpers.

React mounts inside the existing `.site` root. Keep `header.topbar`, `main#main` and `footer.footer` as direct children with their existing IDs, classes, ARIA and element order. Render outside text as React text/nodes; **never** use `dangerouslySetInnerHTML` or a second DOM renderer. The top-level navigation inventory and active-route behavior belong to `src/app/navigation.ts`; both `index.html` and `workflows.html` mount that same inventory. Do not add hand-maintained nav links in either HTML page. Preserve cross-page hrefs and the canonical menu through `pages/tests/navigation.test.mjs` and the Pages browser smoke.

Pages consumes only versioned **public read-only projections** from canonical sources. Never publish raw prompts, tool input/output, Provider sessions, encrypted checkpoints, credentials, host/session identifiers, untrusted HTML or sensitive paths. An unknown measurement is \`null\`, not zero. Preserve source revision and generated-at, never infer SC Pass, realtime online state or orphan integrity from summaries.

All Nession source repository links must point to https://github.com/BestNathan/nession. The scoped MCP Documents exception permits only verified official stable-release links under https://github.com/modelcontextprotocol/modelcontextprotocol, with canonical tag/commit and source path validation.

## Build and publication ownership

Three independent inputs are assembled; none may absorb another's ownership:

1. **Credential-free UI build** — `npm run build:ui` runs Vite into an isolated `.build/ui` directory (`PAGES_UI_OUT_DIR`). It has no tokens, secrets, server or runtime API. `base: './'`, MPA inputs are the two HTML entrypoints, JS/CSS chunks are content-hashed, and no public source maps are emitted.
2. **Trusted data projection** — `npm run build:data` runs `scripts/build-data.mjs` into `.build/data`; it retains the existing Node/Rust projection algorithms, schemas, source pins and MCP last-good behavior.
3. **Curated prototype publisher** — `scripts/publish-prototypes.mjs` remains the only prototype publication boundary; deploy invokes it after assembly.

`node pages/scripts/build.mjs` (the compatibility entry) assembles both inputs into `pages/dist` (`PAGES_OUT_DIR`), with collision checks, fresh isolated inputs and Vite `emptyOutDir` limited to `.build/ui`. When `PAGES_UI_DIR` points at a prebuilt artifact (the credential-isolated deploy job), it skips Vite and only assembles. `PAGES_OFFLINE` keeps the projection runnable without network credentials. `public/` owns the stable `styles.css`, `workflows.css` and `favicon.svg` paths (the prototype redirect relies on `../styles.css`).

`scripts/artifact-manifest.mjs` writes `dist/artifact-manifest.json`: both HTML entrypoints plus the complete transitive local JS/CSS/static closure (including dynamic imports and CSS assets), with normalized relative paths, bounded file count/size and exact SHA-256 per file. The trusted publisher readback (`scripts/verify-published-artifact.mjs`) compares the deployed manifest digest and every published compiled byte against this trusted build output; a matching main SHA is never sufficient.

Local development uses public-safe fixtures from `scripts/dev-fixtures.ts` (no tokens, Rust or server). Use `npm ci` (locked), `npm run dev`, `npm run check` (typecheck + Node tests), `npm test`, `npm run build:ui`, `npm run build:data`, `npm run build`, and `npm run preview`. The Pages browser suite builds the real artifact once through `e2e/pagesGlobalSetup.mjs`; `e2e/helpers/pagesStandalone.ts` serves that validated `dist` under both the root and `/nession/` subpath, replacing only the public data projections with deterministic fixtures. `e2e/pages/parity.test.ts` freezes the pre-migration renderer at the recorded immutable SHA (`BASELINE_SHA`, migration start at `6fb8fe59cfa32d795fcc930bee4297184810cc84`) and compares every top-level/detail route across the declared viewports and both color schemes: exact title/text/links, exact element geometry and computed styles, and bounded screenshot rasterization tolerance, plus search/filter/selection interactions. That tolerance is declared before the comparison and cannot excuse a content or layout regression; parity evidence is written under `e2e/test-results-pages/parity/` for CI artifacts. After a trusted main merge, post-merge Acceptance re-authenticates the exact `Deploy / Public Pages` Run/Attempt and independently re-downloads the anonymous HTTPS artifact manifest and complete compiled closure; the deployed website is never the source of the expected digest, and a successful deployment log line alone is not an Acceptance verdict.


## Curated public prototype artifacts

`pages/scripts/publish-prototypes.mjs` is the **only** Pages publication boundary for reviewed public assets from the shared orphan `prototype` branch. These HTML mocks are an explicit static-gallery exception to the prohibition on projecting untrusted Agent/raw content. The publisher pins the source SHA, bounds files and asset types, refuses symlink/nested asset trees, and injects restrictive browser CSP plus a source link; it never runs prototype JS in a trusted Actions runner.

Do not copy arbitrary PR-head HTML, user-provided data, Agent transcripts, dynamic `innerHTML`, credentials, or raw backend output into this public artifact. Only add public-safe, sanitized fixtures to the prototype branch. A Pages mock must never be treated as authenticated Nession product UI or trusted Acceptance evidence.


## Native prototype discovery

The **canonical prototype catalog is the Pages application route** `#/prototypes` in `src/features/prototypes/PrototypesPage.tsx`, not the orphan branch's separate visual gallery. The standard Pages header/navigation/footer and `styles.css` own the look and responsive behavior; `prototypes/manifest.json` is a strictly validated, pinned read-only listing, not a second UI implementation. Preserve the older `/prototypes/` URL as a redirect. Interactive per-Issue HTML previews **must open in a new tab** from the native Pages catalog (use `target="_blank"` with `rel="noopener noreferrer"`) so the original Pages route and its state remain visible in the previous tab. Standalone mock documents retain a minimal Pages-branded navigation bar back to the catalog and a pinned GitHub source link. Never copy prototype mock CSS over the Pages design tokens or reintroduce a second gallery design.


## Protocol Reference publication

The first Documents surface is protocol-only. The protocol catalog is generated from the canonical Rust codegen `--schema` at the exact main SHA, never hand-maintained, and publishes request/response JSON Schema plus protocol contract versions. Protocol contract `v1/v2` is distinct from Nession Release `0.x.y`: each field has exactly one `Since Nession` value (not a release support matrix): it must be proven by consecutive immutable tagged release schema snapshots with an absent→present transition, or show `Unknown` (or `Unreleased` when only main declares it and the latest release is verified absent). Missing historical snapshots are not evidence that a field is absent. The preferred release schema asset is `nession-protocol-schema.json` with pinned tag/SHA/version provenance. When absent, a separate credential-free pre-build step may reconstruct a historical schema from the exact official tag commit in an isolated temporary worktree with a SHA-keyed cache; the token-bearing Pages publisher only reads and validates this cache, never executes historical tagged code. Never use latest-main source for an older version. Legacy tags with no codegen remain `Unknown`. Keep the Pages build read-only, no runtime GitHub API or credentials. Any Rust codegen failure at a pinned main SHA fails publication.

## MCP Documents publication (#3624, #3735)

The MCP Documents route is `#/documents/mcp`, nested under the existing Documents
navigation. Its Nession Tool names/descriptions/**both** JSON input and typed
success output schemas come **only** from the registered Rust `nession-mcp` Tool
handlers at a pinned source commit, via the `nession-mcp-schema` read-only
exporter. Every Nession-owned Tool must declare a non-placeholder `outputSchema`
(`#3735`); the exporter and publication pipeline reject a missing, empty or
generic-object contract rather than rendering an invented output table. The
supported protocol versions come from
`nession_mcp::protocol::SUPPORTED_PROTOCOL_VERSIONS` and are distinct from
Nession release SemVer and from the latest upstream MCP specification.

The upstream stable revision is fetched from the official MCP repository's
non-draft GitHub release and resolved to its exact tag commit; its changelog
contents must match that commit's Git blob SHA. Drafts and SEPs are not
automatically stable. The source-aware fast path is `pages/scripts/mcp-export-gate.mjs`:
only a validated prior MCP publication, unchanged pinned official stable release,
and a bounded authenticated GitHub comparison that proves no edits to the Rust
MCP/protocol crates, workspace Cargo lock/toolchain inputs or MCP projection
owner can skip the Rust exporter. A missing, divergent, truncated, or
unverifiable comparison **rebuilds** the canonical Tool catalog; it never
becomes a false no-op. This gate only optimizes compilation; the existing
semantic digest and full previous snapshot validation still own publication.

The canonical semantic digest owner is
`pages/scripts/mcp-semantic.mjs` and reconciliation/last-good validation is
`pages/scripts/mcp-reconcile.mjs`. The digest includes both schemas, so an input
or output contract change is a semantic change. Publication schema `v2`
requires an output contract for every Tool. A structurally valid pre-#3735
schema-`v1` snapshot may migrate once by rebuilding from the current typed
exporters; its bytes are never reused, and a malformed `v1`/`v2` snapshot still
fails closed. On unchanged semantics, re-use the previous published MCP
projection byte-for-byte (including its last-changed source SHA) rather than
rewriting it to the latest main timestamp. An unavailable or malformed
upstream/previous source must fail closed, retaining the previously published
public artifact. Never execute an MCP Tool from Pages or project runtime
session/environment/configuration data.

The existing trusted main `Deploy / Public Pages` workflow alone publishes
the MCP data; its ordinary schedule reconciles upstream changes and its
main-push path signal catches Nession MCP crate changes. The workflow verifies
the build's exact SHA-256 bytes against the anonymous deployed HTTPS artifact,
without treating successful publication as Requirement Acceptance.
