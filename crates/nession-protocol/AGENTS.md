# Nession Protocol Instructions

This scope owns work under `crates/nession-protocol/`.

Read [../../docs/architecture/protocol.md](../../docs/architecture/protocol.md) before changing protocol identity, contracts, manifests, resolution, or evolution.

## Ownership

- `nession-protocol` is the Protocol Kernel and canonical owner of version-addressable contracts Nession owns.
- Runtime/provider crates consume contracts; they do not become a second contract owner.
- Generated Web bindings are projections of Rust contracts, not an independent source of truth.
- The removed `nession_common::protocol` compatibility path must not return.

## Contract changes

When adding/changing a Protocol Unit:

1. change the canonical Rust contract;
2. update provider/consumer behavior;
3. regenerate bindings with `just codegen`;
4. run `./gates/run protocol-integrity protocol-codegen-drift`;
5. update architecture docs when the model itself changes.

Notification/control wires without generated operation contracts still have one declaring owner. Follow the protocol architecture and validator rather than inventing another registry.

## Sandbox policy contract (#2681, #3124)

`contracts/sandbox/v1.rs` owns the versioned `SandboxPolicy` shape and the
context capability's Web-safe projection. The canonical policy still rides the
session-create payloads and is omitted from generated bindings because its
native cgroup keys (`memory.max`) cannot satisfy the Web naming rule.

`SandboxPolicyDraft` is the Web-safe editor projection used by the
context/preflight/Enter payloads: Resource/Syscall are typed `{key, value}`
rows instead of dotted fields. `nession-sandbox` materializes the rows into the
canonical policy and remains the only validator; do not add a second sandbox
schema or a second row→policy interpreter in a provider crate. The context
snapshot, catalog, preflight and action results are session-scoped contract
types, generated for the Web.

`SandboxCapabilityCatalog` is versioned: `catalog_version = 2` adds typed
`implementations` (canonical policy path → status + stable reason code +
implementation-owned options/fields). Only schema-registered paths may appear;
do not let a frontend register or synthesize support. The flat
`resource_fields`/`syscall_fields` arrays are the pre-v2 projection. Preflight
and Enter client payloads carry both the context `generation` and
`probe_generation`; the Agent refuses either stale binding.

## Verification

`scripts/protocol-gate.mjs` owns the live static protocol-integrity rules. Do not duplicate its matcher/rule list here.

```bash
./gates/run protocol-integrity
./gates/run protocol-integrity-selftest
./gates/run protocol-codegen-drift
just protocol-list
```

If prose and executable behavior disagree, repair the prose and/or architecture owner; do not create a second checker.
