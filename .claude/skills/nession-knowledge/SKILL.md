---
name: nession-knowledge
description: Use when searching, reading, verifying, creating, revising, superseding, or auditing project knowledge on the dedicated knowledge orphan branch, or assessing a Requirement's Knowledge Impact and source validity.
---

# Nession Knowledge

This Skill owns the **project knowledge query and controlled update workflow**. The normative schema, authority order, record lifecycle, security limits, and Requirement impact template are in [knowledge-ledger.md](../../../docs/engineering/knowledge-ledger.md); do not duplicate the underlying current architecture from source docs. Requirement authoring stays with [nession-writing-requirements](../nession-writing-requirements/SKILL.md).

**Refs:** repository `BestNathan/nession`; shared orphan branch `knowledge`, independent from `main/staging/prototype/agent-store/acceptance-results/task-results/metrics`. Skill source on `main` / `.claude/skills`; knowledge *records* only on `knowledge`. `.agents/skills` points at the Skill root for cross-agent discovery. Never merge the orphan branch into product code.

## 1. Decide what to retrieve

For a task, start with the specific architecture owner or Issue and search the knowledge ledger for existing validated context. A knowledge claim is useful context but not the highest authority. Explicit owner decisions, code/Gates, and current canonical docs take precedence. If records are missing, unavailable, stale or contradictory, say so and cite the actual source rather than synthesizing certainty.

- Stable concept ID -> get latest index pointer and exact revision.
- Topic/question -> search index categories/tags/titles, then free text.
- Why/when did it change? -> read immutable `events/` and Git history at UTC dates, compare old and new revisions.
- Old behavior -> query historical revisions explicitly; avoid treating superseded status as current.
- Requirement drafting -> decide `Knowledge Impact` following section 4.

## 2. Checkout and search — explicit orphan ref

Fetch *only* the branch ref; do not use default-branch code search for knowledge:

```sh
git fetch origin refs/heads/knowledge:refs/remotes/origin/knowledge
git show origin/knowledge:README.md
git show origin/knowledge:index.json
# Search full text (including old revisions); check index status before citing:
git grep -n -i 'terminal' origin/knowledge -- entries
# Exact ID:
git show origin/knowledge:entries/terminal-tmux-control-mode/v0001.md
# An event's exact UTC creation/evolution history:
git log --format='%H %cI %s' origin/knowledge -- events/
git show origin/knowledge:events/2026/10/24/knowledge-ledger-bootstrap.json
```

Inspect filtered current pointers without needing a package dependency:

```sh
git show origin/knowledge:index.json | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
  const q=(process.argv[1]||"").toLowerCase();
  for(const e of JSON.parse(s).entries||[]){
    if(e.status==="verified" && [e.id,e.title,e.category,...(e.tags||[])].join(" ").toLowerCase().includes(q))
      console.log([e.id,e.revision,e.path,e.updated_at].join("\t"));
  }
})' terminal
```

For an as-of-time lookup, use `git log --before=<ISO-8601> origin/knowledge -- events/` to locate candidate revisions, then **inspect their `effective_at` and `recorded_at` separately**; log commit time is not necessarily knowledge effectiveness. Inspect the exact immutable `.json` source metadata and compare the Markdown's SHA-256 before relying on a claim. Pin the Git commit for reproducibility.

**Read failures:** missing branch/entry/source, malformed index, unknown revision or conflicting claims are `Unknown/Pending`; do not silently fall back to a cached model answer or a differently named result store.

## 3. Curated change workflow

1. **Dedupe and authority:** query ID/domain first; determine authoritative code/doc/owner-verified Issue, its exact source SHA, scope and validity. If no verified source, propose `candidate` and exclude from normal answers.
2. **Classify:** `create` new ID; `verify` candidate with evidence; `revise` same concept; `supersede` redirect old concept; `retract` invalid fact. Preserve old content; each transition creates `vNNNN+1.md` and `.json` with an immutable event.
3. **Isolated worktree:** from clean main root (read-only), run:
```sh
git fetch origin refs/heads/knowledge:refs/remotes/origin/knowledge
git worktree add -b kb-<issue>-<topic> .claude/worktrees/kb-<issue>-<topic> origin/knowledge
cd .claude/worktrees/kb-<issue>-<topic>
git branch --show-current # must NOT be main or knowledge
```
4. **Stage only allowed paths:** create revision `entries/<id>/vNNNN.md` and matching `.json`; `.json` contains stable ID, revision, status, UTC `recorded_at`, canonical `sources`, `content_sha256`. Append `events/YYYY/MM/DD/<id>-<revision>-<unique>.json` (`actor`, action, reason, UTC `recorded_at`, source Issue, old/new revisions). Update the *derived* `index.json` pointer **in the same commit**. Avoid any other file modification. Validate content hashes and that existing immutable paths remain unchanged/deleted. The initial bootstrap is an explicit no-entry exception.
5. **Review:** check each source link and SHA, conflict/dedupe, effective-time semantics, new event data and absence of secrets/private traces. Confirm index status and target revision. Run `node scripts/knowledge-ledger-contract.mjs check <ledger-worktree> <baseline-knowledge-sha>` from a main-based worktree after committing the candidate, plus `./gates/run knowledge-ledger-contract`. Fail on either result; **never substitute an LLM summary for a blocking validator**.
6. **CAS publication:** commit; fetch latest shared ref; inspect remote advancement. If another writer has moved an affected ID, stop and reconcile; never blind rebase a conflicting update. Otherwise rebase verified disjoint work and push fast-forward:
```sh
git add entries/ events/ index.json
git commit -m 'docs(knowledge): revise <id> (#<issue>)'
git fetch origin refs/heads/knowledge:refs/remotes/origin/knowledge
git merge-base --is-ancestor origin/knowledge HEAD || { echo 'Remote advanced: reconcile before push' >&2; exit 1; }
git push origin HEAD:refs/heads/knowledge   # no --force
```
7. **Trusted publish:** after local commit validation, use `node scripts/knowledge-ledger-publish.mjs publish <ledger-worktree> <expected-remote-head-SHA>` in an authorized operator environment. It enforces remote exact-head, no-force publication and validated receipt readback. Never provide write credentials to untrusted PR/Agent code. A stale head fails; reconcile without blind replay.
8. **Readback and receipt:** the publisher appends and validates exactly one post-commit receipt per new revision. Check its returned ledger head, pinned entry/event/index/digest and immutable receipt, then attach those URLs to the owning Issue/PR. A `RECEIPT_PENDING` failure must be reconciled; do not manufacture a second divergent receipt or claim completion.
9. **Retry/repair:** existing identical immutable revision/event is idempotent; divergent reuse is a failure. A stale branch tip, missing receipts, changed predecessor, unexpected deletion or failed source check blocks publication; do not force reset/push or erase history.

This public branch is **not** a private memory store. No tokens, private sessions/checkpoints, secrets, prompts, tenant information, or local machine credentials. A non-force Git push only guards concurrent fast-forward, not an authorized adversary: stronger ref ACLs and independent anchoring are separate security work, not implied by the Skill.

## 4. Requirement impact and handoff

At drafting or materially amending any Requirement, use the contract in [knowledge-ledger.md](../../../docs/engineering/knowledge-ledger.md#knowledge-impact-in-requirements):

- `None`: no reusable durable fact changed (include reason and query scope).
- `Read`: refer to existing verified IDs to constrain implementation; no ledger mutation.
- `Create`: new stable concept with a verified source when published.
- `Update`: current concept changes; new immutable revision + change event.
- `Supersede`: the old concept is invalid/replaced; preserve old versions and redirect or retract with evidence.

Fill **related IDs/search, rationale, owner, timing and evidence**. At Issue creation this is planned impact; revisit after code/doc decision and acceptance. Product/Security/Protocol changes may require a knowledge revision, but not all Issues do. A pending required knowledge write is disclosed at handoff and closed only after post-write readback receipt, not from a draft or model assertion. Historical knowledge must remain retrievable even after its successor is live.

## Stop conditions

Stop the update if the orphan ref is missing/unavailable, current source truth cannot be verified, the ID has multiple competing owners, a security leak might be included, or an untrusted PR/Agent would need Git write credentials. Keep result `Pending` and name the owner to resolve it.
