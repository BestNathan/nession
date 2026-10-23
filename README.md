# Nession Prototypes

**Purpose:** a dedicated, history-isolated branch for **all** clickable design prototypes.

- **Branch:** `prototype` (one shared branch, never one branch per Issue).
- **Directory convention:** `<topic>-<issue-number>/` (one prototype per directory; revisions stay inside that directory).
- **Each prototype:** `index.html` (standalone browser UI), `README.md` (scope, data/behavior fidelity, related Requirement).
- **No runtime coupling:** mock-only assets, never production Web/API, secrets, or live user data.
- **Links from Requirements:** use a pin to the exact **prototype commit SHA**, and move the link when the design changes.
- **Hosting:** the main GitHub Pages pipeline only deploys trusted `main`; previews use a separate HTML rendering service. Treat these as design discussions, **not Acceptance evidence**.

## Catalog

| Prototype | Requirement | HTML |
|---|---|---|
| AI Workspace (Scene + dynamic Action Space + Jev mock) | [#2221](https://github.com/BestNathan/nession/issues/2221) | [Interactive HTML](ai-workspace-2221/index.html) · [Protocol](ai-workspace-2221/PROTOCOL.md) |

Do not add more `prototypes/<topic>` branches. Add another sibling directory here.
