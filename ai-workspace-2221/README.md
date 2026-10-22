# AI Workspace — Nession AI Mode Prototype

- **Requirement:** https://github.com/BestNathan/nession/issues/2221
- **Source:** [index.html](index.html)
- **Status:** visual/interaction demo only; independent of Nession product code.

## Behaviors in the prototype

- Centered input before the first resolved intent.
- Composer docks below the workspace after the first intent.
- One dominant interactive capability Item and manual carousel navigation.
- An **Agent List workspace Item** owns its contextual actions: selecting an Agent and clicking its **＋ create Session** opens a **subview inside that same Item**, not another Item or carousel card.
- The same applies to a conversational follow-up (selected Agent → “创建 Session”) while Agent List is the active Item. Its stable `itemId` and workspace Item count do not change.
- The subview uses an inline Session Create form with back navigation, draft preservation, validation and Mock completion. These details are visible in the Workspace State inspector.
- A standalone “创建 Session” request with no active Agent context may create its own independent Item.
- Revisit the same Agent List Item rather than duplicating it.
- Preserve form drafts and selections when navigating or toggling Standard/AI mode.

All Agent/Session records, model decisions, and submit actions are **mocked**. No System 1/TypeSafe/Nession backend call, no real Session created.

Preview: `https://raw.githack.com/BestNathan/nession/prototype/ai-workspace-2221/index.html` for development (branch updates may take minutes), or `https://rawcdn.githack.com/BestNathan/nession/<commit-sha>/ai-workspace-2221/index.html` for a pinned immutable review link. An external HTML safety confirmation may be shown. Pin `<commit-sha>` to the verified prototype commit when linking from an Issue.
