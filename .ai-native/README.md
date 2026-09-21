# AI-Native Semantic Index — Treatment B

This directory is experimental infrastructure for the Narness repository-architecture study.

Treatment B keeps Nession's implementation topology materially unchanged and adds a machine-queryable semantic layer.

The semantic layer provides stable capability identities for the selected terminal/session reconnect slice:

```text
capability://web/transport/reconnect
capability://terminal/session/visibility-wake
capability://terminal/session/attach-state
capability://terminal/session/reattach
capability://terminal/session/route-recovery
capability://terminal/session/runtime-projection
```

Use the resolver:

```bash
node .ai-native/resolve.mjs "late attach success after route switch"
node .ai-native/resolve.mjs capability://terminal/session/reattach
node .ai-native/resolve.mjs --list
```

The resolver is deliberately deterministic and lexical. The experiment is testing whether stable semantic addresses, explicit ownership, dependency edges, invariants, and evidence mappings improve coding-agent navigation. It is not testing an embedding model.

## Constraints

- Source files are not reorganized in Treatment B.
- Runtime behavior is not changed by this index.
- Entries describe stable capabilities, not benchmark task solutions.
- Paths are projections from semantic identities, not the identities themselves.
- The same semantic identities are retained in Treatment C even when physical layout changes.

Generated from frozen source:

```text
0dc28d5e768f3a0421cb17ebc2a88f0e6a84d664
```
