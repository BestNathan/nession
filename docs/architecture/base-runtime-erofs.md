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

## Decision record and current delivery issues

| Responsibility | Work item | Acceptance owner |
| --- | --- | --- |
| OCI layered RootFS → correct native standalone EROFS | [#4252](https://github.com/BestNathan/nession/issues/4252) | nession-erofs source importer, Linux metadata + malicious layer tests |
| Distro/profile catalog → trusted complete multi-platform GHCR release | [#4254](https://github.com/BestNathan/nession/issues/4254) | main-only publisher and independent readback |
| Debian Agent → Ubuntu root + separate Toolchain runtime | [#4255](https://github.com/BestNathan/nession/issues/4255) | Agent/Sandbox Linux-native ABI and mount lease Cases |
| Transient writable root → real apt/dpkg + cleanup | [#4247](https://github.com/BestNathan/nession/issues/4247) | Sandbox native namespace/package manager/teardown Cases |
| Minimal Debian Agent Docker packaging | [#4256](https://github.com/BestNathan/nession/issues/4256) | reproducible CI Buildx and deployed staging compatibility |
| Integration roll-up | [#4245](https://github.com/BestNathan/nession/issues/4245) | no duplicate Registry, Layer or Sandbox owner |

The `bases` orphan catalog is a **proposal approved for this slice**, not an existing branch. The Catalog may reuse trust and CLI protocols of `toolchains`, but its distro filesystem semantics demand their own profile validation. `/etc/os-release=Ubuntu` does not by itself prove executable compatibility: `/lib*/ld-linux*`, glibc, NSS, CA, distro files and actual Toolchain commands must run inside the isolated mount view. The exact OCI Index digest and each platform child Manifest are two different identities; Server/Agent resolve to a compatible immutable per-platform Manifest and the physical EROFS Blob. Mutable catalog tags are never a Session pin.

### Why standalone EROFS instead of a referenced Composite Base

The existing Sandbox Base mount path consumes one verified raw EROFS view. A referenced Composite is a separately modeled OCI closure that requires multiple EROFS backing-device leases and a different mount adapter; #3784 explicitly tracks its unsupported Base role. Publishing one flattened filesystem per architecture makes the first Ubuntu milestone compatible with the current Base mount contract. Separate Toolchains stay **runtime RO mounts**, not flattened into every Base. If Composite Base is later wanted, introduce a dedicated typed source+dependency lease contract rather than quietly passing a metadata EROFS as a standalone lower.

### Operational sequence

```text
[Base release, noncredentialed]
audit Ubuntu OCI digest / apt package set
  -> platform OCI layer resolution
  -> validate+flatten into private root
  -> preserve safe Linux filesystem metadata
  -> make standalone EROFS + extract/native probe
  -> source-bound artifact upload
  -> [trusted main publish, never executes untrusted recipes]
     OCI Config / Manifest / complete platform Index -> GHCR
  -> [read-only independent validation]
     manifest/blob digest and native extracted probes

[Linux Session, normal runtime]
Server resolves authorized Base/Tool Manifest and selected architecture
  -> Agent fetches missing Blob by OCI/authorized route; verifies digest, pins
  -> EROFS MountManager acquires shared immutable Base/Tool physical view
  -> Sandbox MountPlan acquires optional transient root Overlay
  -> bwrap mounts /, /opt/* RO, /workspace independent, /tmp/home/proc/dev
  -> trusted launch barrier verifies policy and starts real Ubuntu shell
  -> tmux detach/reconnect does NOT destroy a running execution
  -> on last real execution exit, unmount owned root, remove ephemeral upper/work,
     then release immutable leases; preserve Workspace and verified Blob cache
```

### Rootless package installation is a separate capability, not a RootFS format

The existing bwrap path uses user namespace isolation and `--cap-drop ALL`; that is a **security constraint**, not proof that root-in-namespace supports every dpkg maintainer script. Native #4247 evidence must inspect `/proc/self/uid_map`, `gid_map`, effective UID/GID/capabilities, Overlay UID ownership/copy-up and actual dpkg `chown`/metadata writes. A specific Ubuntu package (starting with `tree`) may work while service-managing packages remain unsupported. Never change `--cap-drop ALL` to broad capabilities just to claim success. Package installation is user code inside the Sandbox, not an Agent API that executes APT on the host.

Sandbox networking owns permitted egress. Provide only necessary safe resolver/hosts/CA inputs in the namespace; no implicit Debian `/etc` bind, host credential injection or bypass of offline/restricted network policy. APT cannot gain greater network authority than any other user code. Dynamic changes to `/etc`, `/usr`, `/var/lib/dpkg` and `/var/cache/apt` are upper-layer writes; `/workspace` has an independent durable ownership contract.

### Concrete lifecycle and failure table

| Event / failure | Expected behavior |
| --- | --- |
| Read-only Base selected | Existing Base EROFS mounted RO; system package changes are denied |
| Explicit ephemeral writable root | One verified Base lower + one execution-owned Overlay upper/work; no change to EROFS bytes |
| Package installed in A, B uses same Base | B cannot observe A's dynamic package or dpkg state |
| tmux detach / client disconnect | Running execution remains live and retains its current temporary upper |
| Exit/Stop/Reset and new execution | Old upper disposed after safe unmount; persistent Workspace continues |
| Cache warm hit | Same manifest/blob fingerprint, no new image payload download |
| Missing or corrupt OCI/EROFS closure | Fail preflight/Enter with actionable error, never Native fallback |
| Unsupported `/dev/fuse`, userns, Overlay upper filesystem | Report unavailable capability; do not run privileged fallback |
| Apt with forbidden egress | Network request denied; no automatic proxy bypass |
| Agent crash / failed or foreign unmount | Persist ownership/generation receipt, preserve referenced lower and upper for safe reconciliation; never blindly delete |
| Quota/ENOSPC in ephemeral upper | Bound write impact and report failure without corrupting durable Workspace or CAS |

### Verify distinct proof boundaries

PR-head deterministic tests prove parser/sanitizer/trust invariants but **not** Ubuntu runtime compatibility. Real native Linux Case proves mount/ELF/apt/cleanup but **not** GHCR publication. Only authenticated trusted-main release Run/Attempt and independent remote Index/Manifest/Blob readback prove a published Base. Only controlled staging deployment evidence proves that a minimal Docker Agent can execute it with the actual Kernel/FUSE/UID setup. Parent and child Issues preserve these independently Pending until the corresponding receipts exist.
