# Project Knowledge Ledger — ownership and history contract

**Owner:** project knowledge lifecycle and schema. **Requirement:** [#2325](https://github.com/BestNathan/nession/issues/2325). **Repository:** `BestNathan/nession`. **Storage ref:** `refs/heads/knowledge` (an independent orphan Git history).

## Purpose and precedence

The ledger stores concise reusable **validated, sourced project knowledge**, not a second repository implementation or a universal store. Use it to recover stable decisions, architecture context, invariant rationale and operational lessons across Issue/Agent runs.

Authority, highest first:

1. Explicit current user/owner decisions; nearest scoped `AGENTS.md`, root `AGENTS.md` and Vision/Principles as appropriate.
2. Current executable code, protocol/schema, Gate and its verified tests for implemented behavior.
3. Current canonical docs under `docs/` owned by that subsystem and exact-SHA acceptance/provenance records.
4. Verified knowledge with explicit source pointers, reviewed validity and timestamps.
5. Candidate knowledge, historical Issues, old PRs, model summaries and stale/undated notes as **discovery leads only**.

A newer entry does not defeat a verified canonical owner automatically. If sources conflict, cite both, label the knowledge non-authoritative, and route correction to the owning code/doc/Issue. **No unsourced LLM claim may become `verified`.**

## Storage layout

Only the branch `knowledge` holds ledger records; `main` holds this policy and the Skill, never a duplicate copy of mutable knowledge. Do not merge/cherry-pick product history into the orphan ref.

```text
knowledge (orphan)
├── README.md
├── schema/v1.json
├── index.json                     # derived, mutable pointer/cache
├── entries/<stable-id>/
│   ├── v0001.md                   # immutable human-readable claim
│   ├── v0001.json                 # immutable metadata and markdown SHA-256
│   └── v0002.*                    # later create-only revision
├── events/YYYY/MM/DD/<event-id>.json # immutable transition log
└── receipts/<event-id>.json       # optional post-commit SHA receipt
```

IDs: lowercase `[a-z0-9]+(-[a-z0-9]+)*`, unique across domains and never reused. Revision: `vNNNN` monotonically increasing per ID (do not wrap or fill an earlier gap). `index.json` stores one current pointer per ID and is **rebuildable from validated immutable metadata + event order**; its own timestamp is not provenance.

### Mandatory per-revision metadata (`entries/<id>/<revision>.json`)

```json
{
  "schema_version": 1,
  "id": "terminal-tmux-control-mode",
  "revision": "v0001",
  "title": "tmux control-mode boundary",
  "summary": "Short precise reusable assertion with scope and caveats",
  "category": "architecture",
  "tags": ["terminal", "tmux"],
  "status": "candidate",
  "created_at": "2026-10-24T02:57:50Z",
  "recorded_at": "2026-10-24T02:57:50Z",
  "verified_at": null,
  "effective_at": null,
  "supersedes": null,
  "sources": [
    {"url": "https://github.com/BestNathan/nession/blob/<full-sha>/docs/architecture/...md", "sha": "<full-commit-sha>", "role": "canonical"}
  ],
  "content_sha256": "<sha256-of-matching-v0001.md>"
}
```

The example is a **format sketch**, not a real verified claim. Validate structured fields and source existence at the owning exact SHA. Timestamp strings must be UTC ISO 8601 with `Z`; `created_at` remains the first revision time. `recorded_at` is when a revision was committed and `effective_at` is the domain-effective time if independently known; do not substitute one for the other. `verified_at` is non-null only when sources were reviewed. Status is `candidate | verified | superseded | retracted`. A status change requires a new revision and event; never edit old metadata.

### Mandatory event fields

`events/<UTC-year>/<month>/<day>/<event-id>.json` records `schema_version, id, action, recorded_at, actor, reason, source_issue, previous_revision, new_revision, content_sha256` and optional `effective_at, source_pr, source_commit, external_evidence`. Action: `create | verify | revise | supersede | retract`. Actor is provenance/audit metadata **not authentication**. Event path is unique (use stable ID, revision and a collision-safe unique suffix), create-only. Record `null` where a value truly does not apply. Bootstrap is a special event with no knowledge revision.

The commit containing entry+event+index must be all-or-nothing. Its Git SHA cannot appear inside its own immutable event without a circular reference: publish a separate post-commit receipt with `event_path, record_path, content_sha256, commit_sha, branch, written_at` after validating the first commit, or include the SHA in Issue evidence pinned to the exact original record commit. A second receipt commit is a new append-only operation.

## Read and search

1. Fetch the **explicit** `knowledge` ref. GitHub's ordinary code search only covers the default branch and is not an orphan-branch knowledge search.
2. Read `index.json`, select only `status: verified` for default answers; filter category/tags/ID, then open the exact `entries/<id>/<revision>.md` and `.json`.
3. For free-text search use `git grep -n -i <phrase> origin/knowledge -- entries`; for a time interval use `git log --since --until origin/knowledge -- events/` plus event timestamps, distinguishing history time from effective time.
4. Verify source links and `content_sha256`; quote ID, revision, timestamp and canonical evidence in downstream work. For missing/orphan-ref unavailable, report **unknown**, not “no matching knowledge.”
5. Candidate/historical/retracted records require an explicit historical query and are never silently returned as authoritative current truth.

See [nession-knowledge Skill](../../.claude/skills/nession-knowledge/SKILL.md) for exact commands.

## Update protocol and stability

The executable read-only validator is `scripts/knowledge-ledger-contract.mjs`: `check <ledger-worktree> [<base-sha>]` validates schema, UTC events, immutable record digests, source SHAs, index pointers, receipt references and (with the base SHA) every intermediate Git commit delta (so edit-then-restore remains detectable), receipt ancestry/record source paths, and high-confidence secret signatures. `./gates/run knowledge-ledger-contract` runs deterministic positive/negative isolated fixtures through Quality Tooling. This cannot enforce GitHub writer permissions or substitute for server-side branch protection.

Before writing: search for existing IDs, inspect current sources/decision owner, classify new/verify/revise/supersede/retract and determine whether change is justified. Stable IDs survive updates; create a new ID only for a different concept. Prefer targeted one-topic records, no pasted raw Issue dumps. No secret or session data on this public ref.

1. From a dedicated worktree based on the existing `origin/knowledge`, create the next immutable revision Markdown + metadata JSON and exactly one new event; update only `index.json` pointers, then validate structural/content hashes and forbidden path changes against the old head.
2. Fetch latest remote HEAD and reconcile concurrent updates. A stale write must **fail closed** unless its candidate and all affected pointers are revalidated against the new head. Never `--force`, `reset` the remote, change history or clobber an unrelated ID. Compare source/old revision on every retry.
3. Fast-forward push atomically advances the branch commit, then read back the branch SHA, relevant event, revision, source digest and pointer. Publish SHA receipt after the readback, without claiming that a self-declared author string proves authorization.
4. On failure, leave source revision and event unchanged; report pending/manual reconciliation with expected and actual heads. No auto “repair” that deletes history. A divergent replay is a conflict; byte-identical replay is idempotent.

### Controlled publication helper

From a clean isolated worktree based on the existing knowledge ref, create and commit your immutable revision and event with the derived index. Execute the canonical validator first. Then, using a **trusted operator context** with Git credentials separately provisioned, run:

```sh
node scripts/knowledge-ledger-publish.mjs publish <knowledge-worktree> <exact-previous-knowledge-ref-SHA>
```

This verifies remote expected-head identity, validates all changes, refuses a stale ref and any non-fast-forward push, re-reads the remote, appends separate post-commit receipts, validates those and re-reads their commit. A failed receipt push is explicitly `RECEIPT_PENDING`; retry/reconcile, never treat the earlier record commit as a completed transaction. Running it from a PR head or granting secrets to an Agent is prohibited; the helper does not authenticate the operator or grant GitHub permissions. The required regression fixtures run under the `knowledge-ledger-contract` Quality Gate.

### Trust limits

Append-only is **a validated writer contract, not a GitHub server guarantee**. A collaborator with write permission may still fast-forward delete records or rewrite a branch unless separately constrained. #1690 documents stronger orphan-store governance, but does not currently confer authorization/ruleset evidence on this new `knowledge` ref. Never advertise cryptographic immutability, audit independence, or validated writer identity without real protection and independent audit evidence.

## Knowledge impact in Requirements

For every new Requirement or materially changed contract, record:

```markdown
### Knowledge Impact
- Decision: None | Read | Create | Update | Supersede
- Related knowledge: <stable IDs, or explicit search scope and no matches>
- Reason: <which durable fact/decision is affected or why none>
- Owner and timing: <Issue/SC and point where knowledge becomes valid>
- Evidence: <source/PR or pending validation; then immutable revision + event + commit SHA receipt>
```

At issue creation, the impact is a **plan**, not a verified knowledge change. Reassess at implementation and review, and at acceptance/Issue closure: unresolved required updates remain `Pending`. A completed implementation may generate no knowledge write when source truth was unchanged; explain `None`. Do not publish a future-state assertion as verified before its canonical code/decision source actually exists. If retiring a claim, supersede/retract with reason and preserve its historical versions.
