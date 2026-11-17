# Pages ownership — public observatory (Issue #1782)

This is a standalone, anonymous static project. All application code, visual language, design tokens, typography, CSS, navigation, icons and components live under \`pages/\`. There is **no dependency on \`web/\`**: no imports, copied components/tokens/styles, runtime auth, session state or WebSockets. It is intentionally a distinct visual design.

The top-level navigation inventory and active-route behavior belong to `pages/navigation.js`. Both the hash-routed `index.html` and standalone `workflows.html` mount that same inventory; do not add hand-maintained nav links in either HTML page. Preserve cross-page hrefs and the canonical menu through `pages/tests/navigation.test.mjs` and the Pages browser smoke.

Pages consumes only versioned **public read-only projections** from canonical sources. Never publish raw prompts, tool input/output, Provider sessions, encrypted checkpoints, credentials, host/session identifiers, untrusted HTML or sensitive paths. An unknown measurement is \`null\`, not zero. Preserve source revision and generated-at, never infer SC Pass, realtime online state or orphan integrity from summaries.

All Nession source repository links must point to https://github.com/BestNathan/nession. The scoped MCP Documents exception permits only verified official stable-release links under https://github.com/modelcontextprotocol/modelcontextprotocol, with canonical tag/commit and source path validation. Render outside text with \`textContent\`, not dynamic \`innerHTML\`. Use \`node --test pages/tests/*.test.mjs\` for projection/security fixtures and \`node pages/scripts/build.mjs\` for a static Pages artifact. The Pages build has its own dependency-free Node 24 toolchain.


## Curated public prototype artifacts

`pages/scripts/publish-prototypes.mjs` is the **only** Pages publication boundary for reviewed public assets from the shared orphan `prototype` branch. These HTML mocks are an explicit static-gallery exception to the prohibition on projecting untrusted Agent/raw content. The publisher pins the source SHA, bounds files and asset types, refuses symlink/nested asset trees, and injects restrictive browser CSP plus a source link; it never runs prototype JS in a trusted Actions runner.

Do not copy arbitrary PR-head HTML, user-provided data, Agent transcripts, dynamic `innerHTML`, credentials, or raw backend output into this public artifact. Only add public-safe, sanitized fixtures to the prototype branch. A Pages mock must never be treated as authenticated Nession product UI or trusted Acceptance evidence.


## Native prototype discovery

The **canonical prototype catalog is the Pages application route** `#/prototypes` in `pages/app.js`, not the orphan branch's separate visual gallery. The standard Pages header/navigation/footer and `styles.css` own the look and responsive behavior; `prototypes/manifest.json` is a strictly validated, pinned read-only listing, not a second UI implementation. Preserve the older `/prototypes/` URL as a redirect. Interactive per-Issue HTML previews **must open in a new tab** from the native Pages catalog (use `target="_blank"` with `rel="noopener noreferrer"`) so the original Pages route and its state remain visible in the previous tab. Standalone mock documents retain a minimal Pages-branded navigation bar back to the catalog and a pinned GitHub source link. Never copy prototype mock CSS over the Pages design tokens or reintroduce a second gallery design.


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
