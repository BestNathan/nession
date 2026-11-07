# PR Quality and Acceptance Case Smoke — #2917 measured evidence

**Status:** observed exact-run evidence, not a replacement for trusted SC Acceptance.  
**Implementation:** [PR #2925](https://github.com/BestNathan/nession/pull/2925) merged to Main `f30c27da501140ff676497ceda6920729c8d4eba`; [PR #2930](https://github.com/BestNathan/nession/pull/2930) merged to Main `4a5436a8770fed9367a0820eef38417b77525943`.  
**Evidence:** independently completed GitHub Actions PR runs on Ubuntu 24.04. Probe PR [#2931](https://github.com/BestNathan/nession/pull/2931) was closed **unmerged**.  
**Knowledge:** [Nession CI, E2E and acceptance qualification timing](https://github.com/BestNathan/nession/blob/a24aa164350416e262b131e4aba0bd4e9f388148/topics/workflows/nession-ci-e2e-and-acceptance-qualification-timing.md) on the `knowledge` branch.

## SC-04: Before and after

Wall time is `run.updated_at - run.created_at` measured from the GitHub REST run record, not a fabricated duration or isolated execution time. Each after sample is a **different, exact SHA** of one disposable PR, based on `4a5436a8770fed9367a0820eef38417b77525943`, with one changed-file category. These are *same-category, non-identical-SHA* comparisons (one sample per class).

| Category | Prior CI source SHA / Quality run | Prior wall | Candidate exact SHA / Quality run | Candidate wall | Quality verdict |
|---|---|---:|---|---:|---|
| Fixture-only | `968fb5294499fbf5da70b27652deb8a24512bb47` / [42371357810](https://github.com/BestNathan/nession/actions/runs/42371357810) | 370 s | `c341ffa70359860c825e8673c95565115d439bbf` / [42379218472](https://github.com/BestNathan/nession/actions/runs/42379218472) | **24 s** | Pass; Rust/Web/Tooling inapplicable |
| Web-only | `b161d0545eed7c01405f0d8eac338a28b735779e` / [42377591120](https://github.com/BestNathan/nession/actions/runs/42377591120) | 404 s | `1f15e14c4609db7e81e29b3ec93d19a8188c549f` / [42379309835](https://github.com/BestNathan/nession/actions/runs/42379309835) | **230 s** | Pass; independent Web + Tooling, Rust inapplicable |
| Mixed terminal Rust+Web | `e5b4eec319ff7a21446d47fe4e328c06dd88d1e4` / [42375105508](https://github.com/BestNathan/nession/actions/runs/42375105508) | 367 s | `5d5c5f4a383cf236dfa3811287dd11eed39f7d92` / [42379657576](https://github.com/BestNathan/nession/actions/runs/42379657576) | **259 s** | Pass; Rust, Web, Tooling all applicable |

Predeclared targets: Fixture-only Quality under 60 s, Web-only Quality around 3–4 min. Each after run met the target with the measured wall time. Improvement ratios are descriptive only (~94%, ~43%, ~29%); no confidence interval, same-SHA paired A/B or runner/cache equivalence is claimed. Runner scheduling/content and cache temperature can change the result.

### Scope correctness and no dropped evidence

The fixed canonical [scope selector](https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/scripts/ci/quality-scope.mjs) selects applicability on the exact head-versus-merge-base PR diff. It is loaded from trusted Main so older PR heads without the script can be evaluated. Unknown/unverifiable input conservatively selects all Gate families. The historical serial Web/Tooling `web-check` is now a stable fail-closed aggregate waiting for both independently parallel applicable jobs; it cannot Pass a required failed, missing or skipped result. Main Web dist waits for the aggregate and attests exact Run/Attempt/SHA.

Case Smoke selects the trusted PR Case-method obligations *before* provisioning. Real fixture-only [Case Smoke 42379218579](https://github.com/BestNathan/nession/actions/runs/42379218579) completed in **28 s** (vs [historical 42371357772](https://github.com/BestNathan/nession/actions/runs/42371357772) 246 s). Other after-case checks [42379309850](https://github.com/BestNathan/nession/actions/runs/42379309850) and [42379657591](https://github.com/BestNathan/nession/actions/runs/42379657591) passed in 25 s/24 s with zero eligible Cases. Generic representative infrastructure smoke remains in the Main/scheduled lane. No Case-result or success verdict was invented.

E2E: Fixture [42379218482](https://github.com/BestNathan/nession/actions/runs/42379218482) Pass; Web-only [42379309857](https://github.com/BestNathan/nession/actions/runs/42379309857) Pass. Mixed terminal [42379657588](https://github.com/BestNathan/nession/actions/runs/42379657588) **failed closed** (not Pass): the disposable PR deliberately had no linked Issue E2E Verification; the trusted E2E selector rejected `Unresolved Issue E2E obligations require a trusted audit decision`. This is an expected policy boundary for the unlinked test PR, **not** a real feature's accepted E2E regression result. No E2E gate was weakened or bypassed.

On Main `4a5436a8770fed9367a0820eef38417b77525943`, [Quality producer 42378852053](https://github.com/BestNathan/nession/actions/runs/42378852053) successfully emitted the verified Web dist. [Proof consumer 42379261477](https://github.com/BestNathan/nession/actions/runs/42379261477) verified `WEB_DIST_SOURCE_V1` same-source/SHA/run/attempt, restored the artifact and ran Preview parity. The separate not-required path authentically requires *both* Web tests and Web dist skipped, and otherwise refuses unpaired skip or foreign-source evidence.

### Bottleneck and limits

Previously the 63 Tooling Gates (roughly two minutes on a representative run) serialized in the same Web job before Web install/integration; now Tooling/Web execute concurrently behind `scope`, with the stable `web-check` waiting for the slower applicable job and Main artifact building afterward. A no-Case PR avoids Rust/Web/Chromium provisioning. Main push exact-SHA evidence and any eligible E2E/Acceptance still take their own time.

**Statistical limitation:** Three classes, one observed before/after pair each, not controlled repetitions. They prove measured improvement on those samples and preserved routing/Fail-Closed gates, not an SLA or population-wide speedup. Formal SC-04 verdict remains owned by the repository's trusted Acceptance evaluator; this document is only source-linked evidence.

## Trusted PR-stage Acceptance input for SC-04

The [#2941 merged fix](https://github.com/BestNathan/nession/pull/2941) activates a narrow, read-only CI evidence collector exclusively for Issue #2917 at `pre-merge`. Its [pinned study owner](https://github.com/BestNathan/nession/blob/41c131b5a88791bf2561fb772164c386dd99b6c5/scripts/acceptance-pr-quality-cost-study.mjs) does not trust the contents of this document as proof: it fetches the actual six Quality GitHub Runs/Jobs/Steps, three Case Smoke Runs, three E2E Runs, and three disposable probe commit files/parents to independently re-establish exact identities, times and required verdicts. The result is delivered as `ci_evidence.verified_pr_quality_cost_study` to the existing read-only SC evaluator. Only the deterministic Issue updater may project an SC result; no source documentation or Agent statement can confer Pass alone.

This timing/qualification check is **not** equivalent to a universal CI SLA, and the mixed diagnostic E2E remains an authenticated Fail-Closed observation, not a product E2E Pass. Normal PR-stage Acceptance remains CI-evidence-free, and post-merge evidence collection has unchanged semantics. Source provenance: [Main merge 41c131b5](https://github.com/BestNathan/nession/commit/41c131b5a88791bf2561fb772164c386dd99b6c5) and [Issue #2917](https://github.com/BestNathan/nession/issues/2917).

## Sources and publication identity

- [Issue #2917: full exact run list and context](https://github.com/BestNathan/nession/issues/2917#issuecomment-6708007432)
- [Disposable PR #2931: all three sample heads and explicit E2E exception](https://github.com/BestNathan/nession/pull/2931)
- [Main Web dist proof #42379261477](https://github.com/BestNathan/nession/actions/runs/42379261477)
- [Knowledge ledger source revision `a24aa164`](https://github.com/BestNathan/nession/blob/a24aa164350416e262b131e4aba0bd4e9f388148/topics/workflows/nession-ci-e2e-and-acceptance-qualification-timing.md)
