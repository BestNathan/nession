# AI-Native Repository Surface — Treatment C

This directory is experimental infrastructure for the Narness repository-architecture study.

Treatment C keeps the same stable semantic capability IDs as Treatment B, but moves canonical implementation/evidence ownership into behavior-oriented units.

Use the same deterministic resolver:

```bash
node .ai-native/resolve.mjs "late attach success after route switch"
node .ai-native/resolve.mjs capability://terminal/session/reattach
node .ai-native/resolve.mjs --list
```

## Canonical layout

```text
web/src/units/terminal-session/
  transport-reconnect/
  visibility-wake/
  attach/
  route-recovery/
  runtime-projection/
```

Legacy paths under `app/`, `platform/`, and `product/terminal/` remain only as compatibility projections where runtime imports still rely on them. They are not semantic owners.

Primary tests for the selected slice are localized beside the canonical units.

## Stable identities

```text
capability://web/transport/reconnect
capability://terminal/session/visibility-wake
capability://terminal/session/attach-state
capability://terminal/session/reattach
capability://terminal/session/route-recovery
capability://terminal/session/runtime-projection
```

## Experimental intent

A vs B isolates semantic addressability.

B vs C asks whether behavior locality and explicit ownership improve agent navigation and modification efficiency after semantic indexing already exists.

Do not add benchmark-task-specific hints, Txx references, or solution descriptions to this repository surface.

Frozen source ancestor:

```text
0dc28d5e768f3a0421cb17ebc2a88f0e6a84d664
```
