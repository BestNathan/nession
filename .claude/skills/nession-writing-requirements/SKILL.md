---
name: nession-writing-requirements
description: Use when the user requests a feature, change, or enhancement to Nession and requirements need documenting, OR when the user reports a bug/缺陷 that should be recorded or tracked. Use when the user says "我需要一个需求文档", "记录一下需求", "create a requirement", "帮我记录个 bug", "报个 bug 到 issue", "这个 bug 提个 issue", or mentions tracking requirements or bugs in GitHub Issues. Do NOT use for implementation planning (use brainstorming after this) or for bugs the user wants fixed immediately with no record (that is plain superpowers:systematic-debugging).
---

# Nession Writing Requirements

Requirements and bug analyses live in GitHub Issues, not in the repo. Repo: `BestNathan/nession`.

## Classify first

| Input | Path |
|---|---|
| New capability, behavior change, "希望能…" | **Requirement** → `superpowersexy:clarifying-requirements` |
| "should work but doesn't", "X 之后 Y 不刷新", crash, wrong output | **Bug** → `superpowers:systematic-debugging` |
| Ambiguous | Ask which. |

Mixed message (requirement + bug together) → run both paths, one issue each.

Write issue bodies in the reporter's language; keep the section headers below, plus code identifiers, file paths and this skill's own vocabulary (`unverified`, `Investigation Status`), in English.

## Hard rules

- In a hurry ≠ skip the analysis. "直接记一下" means record it efficiently, not record a guess.
- Analysis precedes filing. Never file first and backfill the analysis.
- An unconfirmed mechanism goes under **Investigation Status**, marked unverified — never under **Root Cause**.
- The reporter's scope ("mobile only", "P2P only") is a claim to verify, not a fact. Title by the strongest **verified** fact, never by reported scope and never by an unverified hypothesis.
- A reporter's stated cause that turns out false goes in **Investigation Status** as a verified fact, and gets said out loud in B5. Don't quietly drop it.
- One requirement = one issue. Changes edit in place, never a new issue.
- `bug` is lowercase. Never create `BUG`.
- `Closes #N` belongs only in the `staging → main` release PR body.

---

# Requirement path

1. **`superpowersexy:clarifying-requirements`** — run the clarification process in full
2. **Skip its local-file step** (`docs/superpowers/requirement/...`) — the document becomes the issue body
3. **Ensure labels exist** (see Labels)
4. **Create the issue**
5. **Append the conversation record**
6. **User reviews**, iterate as needed
7. **`superpowers:brainstorming`**

### Issue body

```markdown
## Requirements: [Topic]

[Full document from clarifying-requirements:
 Background / Goals / Non-Goals / Scope / Constraints /
 Success Criteria / Edge Cases / Open Questions]

---
**Status:** Draft | In Discussion | Approved
**Created:** [YYYY-MM-DD]
**Author:** [user]
```

### Commands

```bash
gh issue create --repo BestNathan/nession \
  --title "Requirement: [Topic]" \
  --body "[document]" \
  --label requirement --label web --label ui --label ux

gh issue comment [N] --repo BestNathan/nession --body "[conversation record]"
```

### Conversation record format

```markdown
## Conversation History

### [YYYY-MM-DD HH:MM] — Initial Request
**User:** [verbatim]
**Agent:** [restatement]
**User:** [confirmation / correction]

### [YYYY-MM-DD HH:MM] — Round N: [topic]
**Agent:** [questions]
**User:** [answers]

### [YYYY-MM-DD HH:MM] — Requirements Finalized
```

### Handling changes

```bash
gh issue edit [N] --repo BestNathan/nession --body "[updated document]"   # edit in place
gh issue comment [N] --repo BestNathan/nession --body "[change discussion]"
```

Update Status as it moves: Draft → In Discussion → Approved.

---

# Bug path

1. **B0 dedupe** — scan all open issues, not just `--label bug`
2. **B1 analyze** — `superpowers:systematic-debugging` Phases 1–3
3. **B2 create issue** — title `Bug: [summary]`
4. **B3 label** — `bug` + every applicable area
5. **B4 append the investigation trail**
6. **B5 ask the user**: fix now (Phase 4) or stop here — and hand back the one question that collapses the hypothesis ranking (e.g. "do preset commands fail too?")

### B0 dedupe

```bash
gh issue list --repo BestNathan/nession --state open --limit 100 \
  --json number,title,labels --jq '.[] | "\(.number)\t[\(.labels|map(.name)|join(","))]\t\(.title)"'
```

| Result | Action |
|---|---|
| Duplicate | Comment on the existing issue, don't create |
| Overlapping, not duplicate | File separately, cross-reference `#N` both ways |
| Closed issue, same symptom | Mention `#N` in the new issue |

### B1 analyze

**Phase 1** Read the code, trace the data flow to where the bad behavior originates, check recent changes
**Phase 2** Find the working equivalent path, list the differences
**Phase 3** State the root-cause hypothesis explicitly, test it minimally against the code

**Floor:** trace the reported path end to end (sender → transport → receiver), plus one working-path comparison.
**Ceiling:** static evidence only. Demo stacks, intermittent-race repro, instrumentation → defer to **Fix Direction** as the next step. The ceiling governs **filing**, not fixing — once the user picks "fix now" in B5, the local demo stack and Playwright verification required by `nession-development` apply in full.

Output must separate **verified facts** (with file:line) from **hypotheses** (marked unverified).

Root cause not confirmed (can't reproduce, environment unavailable) → write **Investigation Status**: what was checked, what was ruled out, remaining hypotheses ranked, all marked unverified.

### B2 issue body

```markdown
## Description
[reporter's words, verbatim]

## Reproduction
[steps — mark whether reported or locally verified]

## Root Cause
[confirmed mechanism + file:line]
[or Investigation Status: verified facts / ruled out / ranked hypotheses (unverified)]

## Impact

## Fix Direction
[confirmed → the fix; unconfirmed → the next investigation step]

## Location
- file:line
```

```bash
gh issue create --repo BestNathan/nession \
  --title "Bug: [summary]" \
  --label bug --label terminal --label web --label ui \
  --body "[analysis]"

gh issue comment [N] --repo BestNathan/nession \
  --body "[investigation trail: what was checked, what was ruled out, in order]"
```

---

# Labels

**Kind — exactly one:** `requirement` | `bug`

**Area — every one that applies:**

| Label | Roughly |
|---|---|
| `terminal` | terminal / xterm / tmux behavior, anywhere in the tree |
| `web` | `web/src/**` |
| `ui` / `ux` | renders wrong / behaves or communicates wrong |
| `backend` | roll-up for any Rust-side work |
| `server` `agent` `cli` `protocol` | `crates/nession-{server,agent,cli,common}/**` |
| `infra` | Docker, `k8s/**`, `deploy/**`, shipped `*.toml` configs |
| `ci` | workflows, `scripts/**`, `justfile`, git hooks |
| `test` | coverage and test infrastructure |
| `documentation` | a written convention must change |

### Three rules

1. **Apply every label that applies; when unsure, apply it.** `--label` is AND, never OR, so a single-label pull is only complete if labels are generous. Don't deliberate over whether one *quite* fits.
2. **Label the mechanism AND the affected surface.** A server-side defect that freezes the browser list carries `backend`+`server` *and* `web`+`ux`. Never the surface alone. Mechanism unconfirmed → label every area your ranked hypotheses name; **only those** — an area you never considered is not a labeling reason.
3. **Narrow when the root cause lands.** Drop the areas whose hypotheses lost; keep the confirmed mechanism, its roll-up, and the surface.

```
Bug: terminal toolbar quick command does nothing    → bug, terminal, web, ui, ux
Bug: server drops session events after agent reconnect → bug, backend, agent, server, protocol, web, ux
Bug: nession-cli PTY size not synced after resize   → bug, terminal, cli, backend, protocol, ui, ux
Requirement: group session list by agent, collapsible → requirement, web, ui, ux
Requirement: k8s overlay image tags written by CI   → requirement, ci, infra, documentation
```

Examples show shape only. **The rules win over the examples** — if your analysis names an area an example omits, apply it.

### Bootstrap (once)

```bash
create_label() {
  gh label create "$1" --repo BestNathan/nession --color "$2" --description "$3" 2>/dev/null || echo "exists: $1"
}
create_label requirement 0E8A16 "Feature requirements and specifications"
create_label terminal 1D76DB "Terminal / xterm / tmux behavior"
create_label web      1D76DB "web/src — React frontend"
create_label ui       5DADE2 "Visual appearance, layout, styling"
create_label ux       5DADE2 "Interaction, flow, error feedback"
create_label backend  0E8A16 "Roll-up: any Rust-side work"
create_label server   2EA043 "crates/nession-server"
create_label agent    2EA043 "crates/nession-agent"
create_label cli      2EA043 "crates/nession-cli"
create_label protocol A371F7 "crates/nession-common — protocol, shared types"
create_label infra    6E7781 "Docker, k8s, deploy"
create_label ci       6E7781 "CI workflows, scripts, justfile, git hooks"
create_label test     D4A72C "Test coverage and test infrastructure"
# bug / documentation are GitHub defaults — already exist
```

Missing label? Create it now. Never drop a label to save a command.

---

# Lifecycle

**Requirement:** Draft → In Discussion → Approved → (implementation PR references it) → Closed. Status lives in the body; update it as it moves.

**Bug:** Filed with analysis → on confirmation, one edit updates the body *and* narrows the labels → fix PR references it → closed by the release PR's `Closes #N`.

```bash
gh issue edit [N] --repo BestNathan/nession --remove-label server --remove-label protocol
```

# Edge cases

| Situation | Action |
|---|---|
| No `gh` | Save to `docs/superpowers/{requirement,bug}/YYYY-MM-DD-<topic>.md` and tell the user |
| Already mid-debug | Don't restart the investigation — take the Phase 1–3 findings to B2 |
| User wants the fix now | File first, then Phase 4 on a `fix/` branch. Never fix silently and retro-file |
| Conversation record > 65536 chars | Summarize early rounds, keep recent ones verbatim |
| Which issue was it? | `gh issue list --repo BestNathan/nession --label requirement --search "<keywords>"` |

# Quick reference

Create / comment / edit commands are in the path steps above. Not there:

| Action | Command |
|---|---|
| List labels | `gh label list --repo BestNathan/nession` |
| Pull one area | `gh issue list --repo BestNathan/nession --label terminal --state open` |
| Area + kind | `gh issue list --repo BestNathan/nession --label terminal --label bug --state open` |
| OR several areas | `gh issue list --repo BestNathan/nession --search "label:server,agent,protocol state:open"` |
| Add labels | `gh issue edit [N] --repo BestNathan/nession --add-label terminal --add-label ui` |
| Narrow labels | `gh issue edit [N] --repo BestNathan/nession --remove-label server` |
| Find by title | `gh issue list --repo BestNathan/nession --label requirement --search "<keywords>"` |

# Red flags — stop and start over

- Writing to a local file instead of creating an issue
- Issue has a kind label but no area labels
- Skipping clarifying-requirements (requirements) or systematic-debugging (bugs)
- **Root Cause** contains a guess; or every section but **Description** is unverified
- Issue scoped to the mode / platform / version the reporter named, without checking whether the mechanism depends on it
- A second issue for the same requirement
- Root cause confirmed but speculative labels never removed
- "File it now, analyze later"

# Relationships

```
requirement → clarifying-requirements ┐
                                      ├→ GitHub Issue → brainstorming → writing-plans → executing-plans
bug         → systematic-debugging   ┘                  (bug optionally continues into Phase 4)
```
