# AI Workspace — Nession AI Mode Prototype

- **Requirement:** https://github.com/BestNathan/nession/issues/2221
- **Source:** [index.html](index.html)
- **Status:** visual/interaction demo only; independent of Nession product code.

## Behaviors in the prototype

- Centered input before the first resolved intent.
- Composer docks below the workspace after the first intent.
- One dominant interactive capability Item and manual carousel navigation.
- Agent List item, inline Session Create item; revisit the same item rather than duplicating.
- Preserve form drafts and selections when navigating or toggling Standard/AI mode.

All Agent/Session records, model decisions, and submit actions are **mocked**. No System 1/TypeSafe/Nession backend call, no real Session created.

The interactive HTML can be previewed through a static HTML renderer such as `https://raw.githack.com/BestNathan/nession/<commit-sha>/ai-workspace-2221/index.html`; an external content-safety confirmation may be shown. Pin `<commit-sha>` to a verified commit when linking from an Issue.
