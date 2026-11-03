# Environment · Session Binding Workspace prototype (#2654)

[Owning Requirement #2654](https://github.com/BestNathan/nession/issues/2654) · [Interactive HTML](index.html) · [Prototypes gallery](../index.html)

## Layout revision after #2701 status-bar review (2026-11-03)

[#2701](https://github.com/BestNathan/nession/issues/2701) correctly made desired/observed Session Binding state visible, but PR #2705 introduced a full-width read-only status banner above both Web columns and above the App list/detail/editor. That banner competes with the primary Environment content, duplicates navigator/Profile usage labels and wraps long adapter failures into large header chrome.

This mock now explores the **#2654-owned Session-first composition** rather than preserving that banner:

- **Web:** bounded Profile navigator on the left; flexible main content defaults to **Session Environment** (no empty detail). The Session observation lives alongside the Session title, not in a full-width strip. Profile details retain Variables/Raw and existing actions.
- **App:** the root list shows a compact current-Session item and Profile list; tap Session/Profile to push exactly one detail depth. No second full-width status row above every depth.
- **Normal state:** one quiet line with status, short consequence and a **Details** disclosure; no success-colored badge, no permanent revision telemetry.
- **Pending:** explicit next-shell-prompt boundary; **unsupported_shell**, **error**, or **unavailable** immediately shows an understandable reason and do **not** claim the running shell is in sync. New panes/processes inheritance remains separately explained.
- **Details:** reveal desired revision, applied revision and managed key count only on demand. A failed materialization may retain an older applied revision. Observed-unavailable never silently becomes `in_sync`.
- **Profile semantics:** “Included in Session binding” is not proof of convergence. Each detail can return to the Session observation. Profile Save does not imply Reapply.

**Try it:** use the external `Observed` selector to cycle In sync / Pending shell / Unsupported shell / Apply error / Unavailable, open Details, select a Profile, return to Session, use Manage binding → Apply and the simulated next prompt, and repeat at a narrow mobile viewport. The state selector is a **lab control only**, not a proposed production control. All observed states are synthetic; no real Session state, backend, browser clipboard, Shell ACK, or secrets are accessed.

**Verification:** prototype source authored and revised; source-level checks possible, but real browser interaction, mobile screenshot and exact Pages SHA readback are **not yet independently verified**. #2701's completed production acceptance and #2654's pending product acceptance remain separate.

---

## Question and decision

How should Nession's already-delivered Environment capability (#1202) become **Session-first** without resurrecting a file-management lobby or inventing new global chrome? This prototype explores a default Session Environment overview, a reusable Profile navigator, and **one ordered binding replacement** interaction. #170 is the runtime source of truth; this mock does not change it.

## Scenario

1. Open the HTML mock. The main content defaults to the current `dev-session` Environment overview rather than the old empty "Select a profile" state. Observe two mounted profiles and their precedence.
2. Click any available Profile. Inspect the existing read-first Variables/Raw treatment; secret-like values are **synthetic and masked**. Return using the current Session item or mobile Back.
3. Select **Manage binding**. Add `ai-tools.env`, move profiles up/down and optionally remove one. Review the effective key count and overlap keys; no raw secrets are revealed. **Cancel** discards the complete draft.
4. Choose **Apply changes**. The mock increments the Session materialized revision, shows **Pending next prompt**, and does not mutate or send input to a foreground TUI.
5. Press **Simulate Bash returning to prompt**. The mock changes the status to in sync; this is not an actual tmux/Bash signal.
6. Choose a Profile, click **Simulate profile edit**, then return to Session. The previously materialized Session revision remains unchanged until explicit **Reapply**.
7. Use **无 Session 场景** and **模拟 Agent 断线** to explore truthful empty/unavailable behavior. **Reset** restores the starting state.
8. Repeat at a phone viewport: navigator-first, tap into details, use **Back**; no squeezed two-column layout or second global toolbar.

## UI and interaction constraints

- Web: reuse the #1202 bounded navigator + flexible content composition; default content becomes Session overview.
- App: a single-column navigator and pushed content with a single Back affordance. Production must use the existing Workspace depth owner; mock Back simulates only the visible behavior.
- Session binding is one ordered desired state; buttons do not fire individual live `apply`/`unset` wires.
- Current Session and reusable Profile are separate concepts. No Session means no fabricated active binding.
- Profile Save does not imply Session update; only explicit Reapply or replace changes materialized binding.
- For real operation, Agent may materialize the revised environment for future tmux processes before the current Bash next-prompt sync. The mock's convergence status is illustrative and does not pretend to possess actual per-Shell ACKs.
- Existing Claude Code, Vim, htop and other foreground apps are not mutated or injected into.

## Fidelity

| Dimension | Fidelity |
|---|---|
| Profile names, keys, sources, values, agent/session IDs | Synthetic fixture only |
| Ordered binding, overlaps and effective values | Deterministic in-browser mock calculation |
| Binding edit, draft/cancel/apply, revision states | Local JavaScript state simulation |
| File Save and explicit Reapply | Simulation only; no persistence |
| Server/Agent connection failure | Simulation toggle only |
| Web responsive layout / mobile Back | HTML/CSS approximation, not production React components |
| API, secret storage, tmux, Bash, Shell Hook, client authorization, Workspace state, persistence | **Not integrated** |

The HTML contains **no external dependencies, network calls, real secrets or production side effects**.

## Checks and acceptance boundary

- Static publication sanity: standalone `index.html` includes responsive desktop/mobile layout and the ordered binding interaction.
- Manually test: Session overview, navigator selection, reorder/add/remove, Cancel, Apply → Pending, simulated Prompt, changed-profile/Reapply, unavailable/no-Session, mobile Back, and keyboard focus.
- Browser clickthrough and screenshot evidence **not yet independently verified** by the repository trusted browser runner.
- Production proof remains owned by #2654 and #170. A prototype's simulated status is not an authenticated Server/Agent observation or E2E pass.

## Links and publication

Canonical Pages URL (only live after matching source SHA / HTTP verification):
https://bestnathan.github.io/nession/prototypes/environment-session-2654/index.html

Shared orphan branch source:
https://github.com/BestNathan/nession/tree/prototype/environment-session-2654

Published Pages manifest must report the exact pinned `source.sha` before describing the HTML preview as current.

## Non-goals

No new global Workspace navigation, no third permanent panel, no new secret store, no cross-Session bulk operations, no actual Session runtime/protocol behavior, no redesign of the #1202 Profile editor, and no automatic mutation of already-running TUI programs.
