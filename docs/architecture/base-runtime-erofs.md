# Base Runtime EROFS: isolated Linux userland on a lightweight Agent

> **Status:** proposed product-line design, not a claim of a published Ubuntu artifact.
> Requirement: [#4245](https://github.com/BestNathan/nession/issues/4245).
> Native runtime and apt acceptance: [#4247](https://github.com/BestNathan/nession/issues/4247).
> Existing owners: [OCI/EROFS image infrastructure](oci-erofs-image-infrastructure.md), [Sandbox filesystem policy](sandbox-filesystem-policy.md), [Sandbox execution](sandbox-policy-and-execution.md), [Toolchain Release](../../scripts/toolchains/README.md).

## User outcome

A small Nession Agent Docker image (Debian slim is acceptable) supplies **only**
Nession control/terminal services, Bubblewrap, EROFS/FUSE/Overlay mount helpers
and their genuine host runtime dependencies. A Session may instead run with a
digest-pinned, complete **Ubuntu Base Runtime EROFS** at `/`, mount independent
pinned Toolchain EROFS images at `/opt/<name>`, and use a separately owned
`/workspace`.

Optional **ephemeral writable RootFS** gives that Session a private mutable
system directory tree. It may install packages at runtime if explicitly permitted
by network and Sandbox policy. On final verified release the root upper/work
are destroyed; immutable Image/cache bytes and persistent Workspace bytes remain.

This is not a general OCI container engine. Nession consumes **one flattened
EROFS filesystem per Base platform**, with standard OCI Config, Manifest and
multi-platform Index for identity, delivery and metadata. Runtime mount and
isolation stay with the existing Sandbox implementation.

### Required resource boundaries

| Resource | Owner | Backing | Lifetime |
| --- | --- | --- | --- |
| Agent Docker filesystem | Container/deployment | small Debian userspace, Nession binaries and mount helpers | Agent Pod/container |
| Base OCI / raw EROFS | `nession-erofs`, Server Images, Agent cache | content-addressed immutable per-platform EROFS | registry/cache retention plus image/lease pins |
| Toolchain OCI / EROFS | existing #4160 catalog; `nession-erofs` and Images | separate immutable per-tool payload | registry/cache retention plus image/lease pins |
| Writable root upper/work | `nession-sandbox::mount::TransientRootfsBackend` | local supported writable filesystem, transient Overlay | one execution, removed after verified last unmount |
| Managed Workspace | Agent Workspace registry + Sandbox mount backend | authorized persistent write directory / optional shared overlay | Workspace identity, not execution root lifetime |
| `/dev`, `/proc`, `/home`, `/tmp`, `/run` | Sandbox runtime mounts | ephemeral/explicit safe mounts | Sandbox execution |

### Existing implementation (2026-11-22 main)

- #3024 mounts a verified EROFS Base read-only at `/`; #3435 selects it from
  the authenticated filesystem declaration; #3495/#3500 own OCI metadata.
- #3695 moved typed mount/view/overlay ownership to Sandbox.
- #3698 provides opt-in transient writable RootFS with ordered immutable lower
  support, cleanup and fail-closed capability reporting. Do **not** recreate
  the Overlay manager for Base releases.
- #4160 provides the **single-tool-only** orphan catalog and trusted
  GHCR release architecture; its scripts/publisher must not accept arbitrary
  Base source content as though it were a one-tool filesystem.
- `nession-erofs::build::oci::ProcessOciConverter` defines an external
  conversion adapter but does not prove that a real Ubuntu production converter
  is deployed. `ErofsBuilder::build_local` intentionally refuses absolute
  symlinks / special files; it is suitable for a narrower ordinary directory
  input, **not** for blindly repacking Ubuntu's usrmerge hierarchy.
- The generic EROFS Image Manager may store/serve both kinds through existing
  format/Registry primitives, but real Ubuntu source-to-published-EROFS
  readback has not been demonstrated in this design.

## Base release contract (target)

### Catalog: separate from single-tool definitions

Use an independent `bases` orphan branch, not `toolchains`:

```text
bases/
  README.md
  ubuntu/
    24.04/
      minimal/build.sh
      dev/build.sh
```

Each version/profile script supports `targets`, `prepare --platform
linux --arch ... --rootfs ABSOLUTE_EMPTY_DIR`, and `verify --platform
linux --arch ... --rootfs DIR`. A profile is a **distro filesystem
distribution**, not a multi-tool bundle recipe. Keep the shell contract small;
otherwise the trusted main-owned release pipeline must distinguish tool and
base semantics in a single well-defined adapter, not duplicate OCI backends.

The script locks **exact** Ubuntu OCI source digest and architecture, selected
apt repository snapshots or immutable package inputs, exact package versions,
build dependencies and per-platform closure. V1 fingerprint may use SHA256 of
the exact self-contained `build.sh` bytes, but this only detects recipe
changes: it does **not** make mutable apt repositories reproducible. The release
must fail/explicitly report when a pinned input has drifted or vanished. Do not
use unverified `ubuntu:24.04` tag resolution as a supply-chain proof.

Initial profiles:

- `ubuntu/24.04/minimal`: `/bin/sh`, loader/glibc, CA certificates, basic
  DNS/NSS config, apt/dpkg, package index state and required Sandbox mountpoint
  directories, without embedding host secrets/caches.
- `ubuntu/24.04/dev`: minimal plus bounded, audited Ubuntu packages such as
  build-essential, gcc/g++, make, pkg-config, git, curl, Python 3 and SSH client.
  Keep Rust, Node, Claude, Codex, kubectl, cf and other independently versioned
  toolchains as separate `/opt/<name>` EROFS mounts.

Do not assume Ubuntu's `apt` package is runnable merely because it is present
on disk. Package-manager execution in writable Sandbox is a separate #4247 proof.

### OCI source flattening

For a selected source platform:

1. Authenticate and select the exact platform Manifest from the pinned source
   OCI Index. Apply layers in OCI order, honoring whiteouts and opaque
   directory semantics; OCI Index itself is **not** a union filesystem.
2. Retain valid rootfs absolute links (e.g. `/bin -> usr/bin` when supplied),
   relative links, hardlinks, UID/GID, executable permissions and supported
   filesystem metadata while preventing path traversal, host filesystem
   access, unsafe special file/device creation and hostile extended attributes.
3. Produce a privately staged complete rootfs and one raw, standalone EROFS
   blob. Validate actual `fsck.erofs` extraction, link/ownership/permission
   parity, expected ELF interpreter and fixed package inventory.
4. Preserve an audited OCI Config `Env` and RootFS annotations
   (`io.nession.kind=base_runtime`). The output Config's rootfs diff ID
   references the new EROFS bytes, **not** the upstream OCI tar layers.
5. Materialize a separate platform Manifest, then a complete OCI Index. Bind
   source provenance, exact recipe SHA/fingerprint, platform and new EROFS
   digest in verified release receipts.

The normal `ErofsBuilder::build_local` path must retain its existing
fail-closed rules. Implement/verify a specialized OCI-rootfs adapter instead
of weakening generic source validation globally.

### Trusted publisher, existing Registry owner

Follow #4160's authority partition: no Registry write credentials in orphan
recipe execution, no untrusted recipe execution inside the trusted publisher,
digest-bound artifact transfer, and independent native extracted probes.

Publish under one repository:

```text
ghcr.io/bestnathan/nession-base:ubuntu-24.04-minimal
ghcr.io/bestnathan/nession-base:ubuntu-24.04-dev
```

These tags are version/profile pointers, **not immutable identities**.
Consumers bind the immutable platform Manifest/Index digest. Require the full
advertised architecture set before changing a tag; never replace a complete
Index with a partial one. Implement via `nession-erofs`'s existing
CAS/OCI/Registry, not a second ORAS/Docker push implementation. Preserve prior
digest history and authenticated publisher Run/Attempt receipts.

## Runtime assembly (target compatibility, owner unchanged)

```text
Agent host (Debian, slim)
  /data/erofs/agents/<agent-id>/sha256/<digest>   shared immutable local cache
  sandbox execution state
    rootfs-overlay/{upper,work,merged}           disposable, execution-owned
  managed Workspace                            persistent, Workspace-owned

Inside a configured Sandbox:
  /                  Ubuntu Base EROFS + optional transient writable Overlay
  /opt/node          immutable Node toolchain EROFS
  /opt/rust          immutable Rust toolchain EROFS
  /workspace         persistent, separately selected Workspace
  /dev, /proc        restricted runtime-mounted views
  /tmp, /home        runtime-owned scratch (not implicitly persisted)
```

Required `/dev`, `/proc`, `/run/nession`, `/workspace`, `/tmp` and
`/home` must exist as compatible mount targets in the Base. A normal Base
config provides only default `Env`, never execution authority, host binds
or arbitrary entrypoint execution. The Agent does not implicitly lend Debian
system libraries into Ubuntu; toolchain ABI/loader dependencies must resolve
against Ubuntu or their own verified closure.

The existing bwrap launcher uses `--unshare-user` and `--cap-drop ALL`.
Do not infer that an `apt-get install` will succeed from a writable mount
alone. Verify actual UID/GID mapping, `chown`/dpkg post-install needs,
`/etc/resolv.conf`/CA setup and network policy. Any required policy change
belongs to Sandbox and must retain default isolation; no automatic privileged
Docker Pod, CAP_SYS_ADMIN, host socket, or unrestricted network egress.

## Evidence-oriented delivery

1. **Conversion semantics first (#4245)**: source-pinned amd64/arm64 Ubuntu
   rootfs, native EROFS pack/extract tests, absolute-link/whiteout/ownership
   negative fixtures and deterministic build receipts.
2. **Trusted publication (#4245)**: source-bound separate catalog, existing
   main-owned OCI publisher, full platform closure, immutable GHCR Index
   digest, read-only remote objects and uncredentialed extracted shell probes.
3. **Consumption (#4245)**: one Debian Agent resolves/pins Ubuntu Base +
   independent toolchains and launches a true Ubuntu userland with mountinfo
   evidence; reject missing image/capability instead of host fallback.
4. **Disposable package installs (#4247)**: in a controlled native Linux
   Sandbox, execute apt install with explicitly permitted egress. Two Sessions
   must have isolated root uppers, one persistent Workspace and unchanged Base
   digest/cache bytes. Verify exit/interruption/restart and failed unmount
   recovery with measured clean-up evidence.

Success is not a documentation PR, a test-only synthetic EROFS fixture, a
green workflow alone, or an unverified `docker run --privileged` demonstration.
Each phase retains its own outstanding acceptance evidence in #4245/#4247.
