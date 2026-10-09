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

## Verification

`scripts/protocol-gate.mjs` owns the live static protocol-integrity rules. Do not duplicate its matcher/rule list here.

```bash
./gates/run protocol-integrity
./gates/run protocol-integrity-selftest
./gates/run protocol-codegen-drift
just protocol-list
```

If prose and executable behavior disagree, repair the prose and/or architecture owner; do not create a second checker.
