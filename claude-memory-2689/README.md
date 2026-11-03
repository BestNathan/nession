# Claude Code Auto Memory · Session-first prototype (#2689)

[Owning Requirement #2689](https://github.com/BestNathan/nession/issues/2689) · [Interactive HTML](index.html) · [Nession prototype library](https://bestnathan.github.io/nession/#/prototypes)

## Question and decision

**Question:** How does a person working in a Nession Session read that Session's Claude Code Auto Memory without selecting a Repository, browsing the global Claude directory, or navigating away from their current work?

**Decision to test:** Session is the only work entry. Claude Code capability appears contextually; its Workspace Memory view resolves **current Session → owning Git repository → effective Claude Code Memory**. The Repository appears only as *read-only provenance*, never as an editable filter. The same repository/worktree shares its Memory; a different repo cannot show the previous repository's content.

## Mock scenario

1. Open the prototype: the **current `dev-session`** is in a terminal, with the contextual Claude Code Workspace open to **Memory** for immediate visual review. Click **返回终端**, then **Claude Code** to exercise the whole entry transition.
2. Read the automatically selected `MEMORY.md` index, choose a topic file, and use index links to open another file. No repository selector appears.
3. Open the read-only **来源** disclosure: it explains the current Session CWD, Git root, shared repository identity, and mock effective Memory directory.
4. Click the **Session name** to switch to `review-worktree`. It has a different CWD but the same Git repository identity, so the Memory content remains shared and a valid topic selection can persist.
5. Switch to `vol-agent`: repository identity and memory content change atomically; old selected topic and in-flight content must never appear under the new context.
6. Switch to `clean-repo` (valid Repo, no Memory), `offline-shell` (Session CWD unavailable), `restricted` (read denied), or `scratch` (documented non-Git fallback with no Memory); inspect distinct empty/error states.
7. Return to `dev-session`, open a topic file, then rapidly change Sessions while content is loading. Observe stale response cancellation.
8. Narrow the viewport to ~390 px: Workspace occupies the screen, file selection pushes to a full-width reader, **返回列表** preserves list position, and **返回终端** returns to the work surface.

## Ownership and interaction contract

- **No global Memory inventory or Repo dropdown.** Session switching is normal Nession navigation. Repo name/path under **来源** is read-only and is automatically derived from the current Session.
- **Memory is inside Claude Code Capability**, adjacent to conversations/configuration, not a standalone global feature or a permanent new navigation node.
- **Read-only content:** `MEMORY.md` functions as an index, topic Markdown files as details. Opening a file performs a simulated bounded read. File list and reader have their own scroll owners on desktop; mobile uses list → detail.
- **State separation:** `ready`, `empty`, `unavailable`, `access_denied`, and non-Git fallback are distinct fixture cases. The mock uses a request generation counter so delayed callbacks from an old Session cannot write content into a newer one.
- **Same-Repo cross-worktree behavior:** `dev-session` and `review-worktree` intentionally resolve to one shared fixture; same key means the selected topic can be retained, but UI still refreshes after the Session switch.
- **No false inference:** This prototype does not implement Git identity resolution, Claude Code config override handling, Agent RPC, permission checks, actual file reads, or any production protocol. Source locations are illustrative, not verified effective Claude Code paths.

## Fidelity

| Dimension | Fidelity |
|---|---|
| Session, Agent, CWD, worktree/repo identity and Memory files | Entirely synthetic, public-safe fixtures |
| Repository resolution, non-Git fallback, Claude configuration path | Deterministic mock mapping, not real Git or Claude Code detection |
| Memory topics and `MEMORY.md` contents | Synthetic Markdown-like editorial samples |
| Listing, reading, Session switching, stale-response prevention | Browser-only JavaScript state simulation |
| Terminal, Capsule, Workspace, mobile push navigation | Approximation of Nession product grammar |
| Runtime/transport/authentication/security/production E2E | Not connected or verified |

## Verification

- Standalone HTML/CSS/JS, no network calls, CDN dependencies, live terminal data or credentials.
- Static check: `node --check app.js`; inspect local relative assets, interactive controls and CSS viewport rules.
- Browser clickthrough: desktop and mobile, Session switch/worktree sharing/cross-repo isolation/empty/denied/unavailable/memory index/topic/back/keyboard.
- Never infer production Acceptance Pass from this prototype. Exact browser verification and any live Pages SHA validation must be recorded separately.

## Publication

After publishing from the shared orphan `prototype` branch, the intended direct HTML URL is:
https://bestnathan.github.io/nession/prototypes/claude-memory-2689/index.html

The directory's source is:
https://github.com/BestNathan/nession/tree/prototype/claude-memory-2689

The Pages URL is **not verified** until `prototypes/manifest.json` matches the exact published prototype commit and HTTPS readback confirms that this HTML is served.

## Non-goals

No separate Memory storage/index service, no global Memory explorer, no manual repository selection, no editing/writing/import/export, no actual model decisions, no file synchronization, no unapproved new product shell or fixed always-visible navigation, and no production change to Claude Code Protocol Units.
