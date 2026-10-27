# Nession Prototypes

**Purpose:** a dedicated, history-isolated branch for **all** clickable design prototypes.

- **Branch:** `prototype` (one shared branch, never one branch per Issue).
- **Directory convention:** `<topic>-<issue-number>/` (one prototype per directory; revisions stay inside that directory).
- **Each prototype:** `index.html` (standalone browser UI), `README.md` (scope, data/behavior fidelity, related Requirement).
- **No runtime coupling:** mock-only assets, never production Web/API, secrets, or live user data.
- **Links from Requirements:** use a pin to the exact **prototype commit SHA**, and move the link when the design changes.
- **Hosting:** the main-owned `Deploy / Public Pages` pipeline publishes an inert, sanitized static copy from the pinned `prototype` SHA at [Nession Pages / Prototypes](https://bestnathan.github.io/nession/prototypes/) when the deployment workflow runs. A direct preview is `https://bestnathan.github.io/nession/prototypes/<topic>-<issue-number>/index.html`. These links are only confirmed live after exact HTTPS readback; do not confuse a source browser with a rendered preview.
- **Source:** keep the separate GitHub URL `https://github.com/BestNathan/nession/blob/<published-sha>/<topic>-<issue-number>/index.html` for exact provenance. Preview pages expose this with **View source**.
- **Timing:** updates to this orphan branch do not immediately redeploy Pages; trigger the trusted main workflow manually or rely on its scheduled run. Always check the published `prototypes/manifest.json` SHA before claiming a refreshed preview.
- **Evidence:** mock HTML is design discussion material, **not Acceptance evidence**.

## Catalog

| Prototype | Requirement | HTML |
|---|---|---|
| AI Workspace (Progressive Action Space + Pending Goal + Jev mock) | [#2221](https://github.com/BestNathan/nession/issues/2221) | [Interactive HTML](ai-workspace-2221/index.html) · [Protocol](ai-workspace-2221/PROTOCOL.md) |

| AI Conversation (Text → business component → Text) | [#2254](https://github.com/BestNathan/nession/issues/2254) | [Interactive HTML](ai-conversation-2254/index.html) · [Protocol](ai-conversation-2254/PROTOCOL.md) |
| Fixed-column Terminal / real CSS font-size simulator | [#2487](https://github.com/BestNathan/nession/issues/2487) | [Interactive HTML](terminal-fixed-cols-2487/index.html) · [Scenario & fidelity](terminal-fixed-cols-2487/README.md) |

| Agent process discovery / capabilities | [#2514](https://github.com/BestNathan/nession/issues/2514) | [Interactive HTML](agent-process-discovery-2514/index.html) · [Scenario & fidelity](agent-process-discovery-2514/README.md) |

Do not add more `prototypes/<topic>` branches. Add another sibling directory here.
