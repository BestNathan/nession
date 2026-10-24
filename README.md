# Nession Project Knowledge Ledger

This dedicated `knowledge` branch is an **orphan Git history**, separate from `main`, `staging`, `prototype`, `agent-store` and acceptance/task/metrics stores. Do not merge it into any product branch.

See [nession-knowledge Skill](https://github.com/BestNathan/nession/blob/main/.claude/skills/nession-knowledge/SKILL.md) and [governance](https://github.com/BestNathan/nession/blob/main/docs/engineering/knowledge-ledger.md) once merged. Tracking Requirement: [#2325](https://github.com/BestNathan/nession/issues/2325).

- `entries/<id>/v0001.md`, `v0002.md`, ...: **create-only** revisions, human readable. Never edit or delete.
- `events/YYYY/MM/DD/<event-id>.json`: **create-only** UTC change records. Never edit or delete.
- `index.json`: mutable and rebuildable lookup cache, with exactly one active pointer per stable knowledge ID. Never treat as evidence by itself.
- `receipts/`: optional post-commit receipts referencing immutable Git commit SHAs (no record may contain its own commit SHA).
- `schema/`: versioned storage contracts (new versions only; no in-place contract rewrite).

Read `index.json` first, resolve a revision path, inspect its sources (Issue/PR/current canonical docs/Git SHA), then decide if it is still valid. Entries start untrusted until verified against canonical owners. Missing/stale/conflicting claims are not authoritative.

Writes require one-owner review, schema/source validation, idempotence, expected-head CAS/fast-forward, readback and a matching append-only event. Never force-push. This GitHub branch is public; **no private prompts, secrets, user/tenant data, credentials, session snapshots or sensitive traces**. Non-force push is not server-enforced immutability; trust restrictions remain an independent deployment concern (#1690).
