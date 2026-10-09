# Nession Documentation Instructions

This scope owns documentation placement and maintenance under `docs/`.

## Choose the owner

- `docs/architecture/` — current durable technical architecture and ownership.
- `docs/design/` — current product/UI design doctrine and contracts.
- `docs/engineering/` — repository/development/quality-system architecture.
- `docs/superpowers/` — historical specs/plans/requirements; useful provenance, not automatically current truth.

Do not move a current invariant into a historical plan and call the migration complete.

## Writing rules

- Prefer one canonical explanation; link to it from Skills/scoped instructions.
- Preserve non-obvious rationale when it prevents regression, but keep implementation-sensitive lists at their executable owner.
- Distinguish current architecture from historical decision records.
- Update links when moving an owner.
- Root `AGENTS.md` remains an index of repository-wide constraints, not a documentation catalog.

Instruction architecture is documented in [engineering/instruction-architecture.md](engineering/instruction-architecture.md).
