# Prototype decision and revision playbook

This is the detailed procedure referenced by `nession-writing-requirements/SKILL.md`. Its decision and synchronization obligations remain binding for user-facing Requirements and interaction-changing Bugs.

## 2a. Decide whether the Requirement needs an interactive prototype

For every **user-facing Requirement** or **Bug that changes a product interaction**, explicitly make a **prototype decision at Issue drafting time**—after dedupe and before treating the interaction contract as settled. The decision belongs to **this Skill**; creating, testing and publishing the artifact belongs to [nession-prototype](../../nession-prototype/SKILL.md).

Do not treat "UI-related" as an automatic mandate to prototype every ticket:

| Decision | When to use | What to do |
|---|---|---|
| **Required** | The user explicitly requests a prototype; a **new interaction paradigm** or navigation/surface model; AI/intent-driven or dynamic components; multi-step flow with ambiguous state, placement, return/reuse, permission or confirmation semantics; substantial desktop/mobile behavior tradeoff; or two plausible UX designs need user validation | Record the open decisions and walkthrough; produce a clickable prototype **before relying on the design for production implementation or final product sign-off**, unless the product owner explicitly defers it |
| **Optional** | Existing UI pattern is mostly understood but a new visual composition or a localized interaction tradeoff would benefit from a quick hands-on comparison | State what decision the prototype would resolve; build if it changes product confidence or the user requests it |
| **Not needed** | No new user interaction (backend/CI/protocol/internal refactor); a precise, already-settled UI pattern; copy/spacing fixes or a narrowly reproducible bug adequately proven by existing tests/visual evidence | Record a short reason when UI-facing; proceed with the relevant development/design/Acceptance workflow |

Quick test: **Could two implementers satisfy the written Success Criteria with materially different user experiences?** If yes, prototype the disputed experience or specify it more precisely. A prototype is valuable for testing behavior, **not** for replacing a missing Requirement contract.

### Record the decision in the Issue

For UI/interaction issues, put a concise `### Prototype` subsection inside `## Requirements: ...` (or a small analogous section in a Bug's Description) with:

~~~markdown
### Prototype
- Decision: Required | Optional | Not needed
- Reason / interaction uncertainty: <specific question, or why unnecessary>
- Scenario to validate: <entry -> actions -> states -> expected result>
- Status: Planned | In progress | Reviewed | Deferred | Not needed
- Artifact: <immutable prototype branch SHA + source and browser preview once published>
- Fidelity / verification: <mock vs live; static/smoke/browser checks and gaps>
~~~

Before building a **Required** prototype, settle the Issue owner, observable interaction questions and representative Success Criteria. It is fine to create the Issue **first** and attach the prototype during discussion. Use [nession-prototype](../../nession-prototype/SKILL.md) to create the actual artifact; the existing shared orphan `prototype` branch must **not** be mistaken for a production feature branch or PR head. If the product owner explicitly waives/defers an otherwise Required prototype, record **why**, what remains uncertain and how the behavior will be validated instead.

After publishing, replace placeholders with a **pinned immutable commit** source link and (first in the Artifact line) the **direct HTML Pages preview** `https://bestnathan.github.io/nession/prototypes/<topic>-<issue-number>/index.html`, if its HTTPS delivery and `prototypes/manifest.json` pinned SHA have been verified. Never present a GitHub blob/source viewer as the primary 'preview'. Put the source URL separately; if Pages is not published yet, say so rather than treating a constructed URL as verified. Include an honest mock/browser-fidelity note. Refresh the reference when the prototype changes. In production implementation Issues, **do not tick Success Criteria or mark Acceptance Pass based only on a mock prototype, screenshots, or parser smoke tests.** The native Pages library is `https://bestnathan.github.io/nession/#/prototypes` (the old `/prototypes/` URL redirects); each individual standalone HTML remains at `https://bestnathan.github.io/nession/prototypes/<topic>-<issue-number>/index.html` and must link back to the Pages library. If delivering the prototype itself is an explicit requirement, give that deliverable its own observable SC and normal Acceptance Plan/Report ownership. Prototype evidence is design evidence; trusted production proof remains with `nession-acceptance`.

## 2b. Revisions must audit and synchronize linked prototypes

When an **existing** Requirement/Bug or its approved UX design changes (Session/work context, navigation hierarchy, visible concepts, responsive behavior, state transitions, error/empty paths, action semantics or acceptance expectations), check whether the Issue links a prototype. This check is **mandatory** even if no new prototype was requested in the latest message.

- Determine whether the design change makes any existing HTML, fixture, scenario, screenshot, gallery description, or Issue preview/source pin misleading. Record the supersession and preserve earlier acceptance/evidence history.
- If affected, treat prototype synchronization as part of **the same requested design change**, not an optional unrelated task: invoke `nession-prototype`, update the owning prototype in place, its scenario README and gallery metadata, and re-run checks against the **revised** interaction.
- The Issue must state whether the revised mock is **Current / Updating / Stale**, with the latest immutable source SHA and verified Pages HTML/manifest revision where available. If publication or browser validation cannot be proven, state that limitation; a working old URL is not proof of the new design.
- When synchronization cannot be done, prominently label the old prototype **stale / superseded** and record exactly what remains and who owns it. Do not silently leave it cited as the approved experience or mark prototype-specific Success Criteria as satisfied by old evidence.
- Do not change backend-facing requirements or protocol solely to imitate a mock UI. Preserve distinct ownership of product concepts and backend implementation details.

The authoring skill owns **detecting the cross-artifact dependency**, while `nession-prototype` owns making and validating the revised artifact. A real product UI change additionally follows `nession-web-design` for browser/design verification.

