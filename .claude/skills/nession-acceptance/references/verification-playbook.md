# SC verification playbook — choose proof before choosing an executor

This is the **task procedure** for Nession Requirement authors, Developer/Reviewer Agents and Acceptance operators. The executable contracts remain `scripts/acceptance-plan.mjs`, `scripts/requirement-acceptance.mjs`, the trusted workflows, and the source-aligned Case contract in `docs/architecture/acceptance-cases.md`. Do not encode a second acceptance schema, verifier registry or result policy here.

## Two supported proof methods, several proof families

- `method: agent`: read-only evaluation of **existing, concrete** source, deterministic Gate/test output, CI receipts and authenticated external records. The Agent may run **safe local narrow preflight** while developing, but its opinion or a command it did not execute/observe is not proof of a runtime scenario. It cannot grant itself privileged credentials or issue-write authority.
- `method: case`: an **executed source-aligned Case** with observable assertions and trusted result ingestion. The Case runner owns runtime setup, verifier steps, reporting and cleanup. Select a verifier by the behavior under test, not by whether it is convenient to launch a browser.
- Human review, exploratory testing, device observation, prototypes and screenshots are **supporting evidence**, not a third supported `method`. If they cannot be transformed into a trustworthy, reproducible Case/attestation, the SC remains `Pending` until its verification contract and execution path exist.

Do not introduce `method: manual`, `browser`, `unit` or `remote` in Issue YAML: `scripts/acceptance-plan.mjs` accepts only `agent | case`. Browser/protocol/runtime are **Case verifier types**, not SC methods; local/staging/deployed are **execution contexts**, not methods.

## Proof-family decision matrix

| Observable assertion to prove | SC method | Components / procedure | Minimum acceptable evidence |
|---|---|---|---|
| Static contract, architecture boundary, parser invariants, configuration rules, deterministic negative fixtures | `agent` **only if existing executable checks and source inspection suffice** | Exact checkout; source/diff and relevant `./gates/run --describe <id>`, `./gates/run <id>`, `node scripts/* self-test`; read exact CI job when needed | Relevant implementation path/line + **specific** assertion/test and outcome at the target SHA; for security rules include rejection/negative case, not prose alone |
| Isolated deterministic behavior or regression test | `agent` if an independently executed Gate/test already proves the SC; otherwise `case` when an executable product scenario is the assertion | Narrow test/Gate in an isolated dev worktree; where necessary an issue-owned Case and CI runner | Test/Case ID, exact assertion, observed result, SHA and authenticated Run/Attempt for formal projection; no blanket “tests passed” |
| UI, Web/App layout, focus, touch, navigation, visual, clipboard or xterm rendering | `case` for behavioral/visual acceptance; `agent` only for a **separate** static token/design-contract SC | `nession-web-design`; controlled dev browser for preflight; `type: browser` Playwright Case in approved CI; use representative viewport/input modality | Action → state/DOM/computed-style/accessibility or xterm buffer assertion; viewport and input details; screenshot/trace as supporting artifact; real-device proof when platform-specific behavior cannot be simulated |
| Terminal, tmux, WebSocket/transport, reconnect, process lifecycle, sandbox isolation | `case` if runtime behavior must be observed | `type: protocol` for frames/ordering; `type: runtime` for process/file/cgroup/namespace/tmux state; `type: browser` only when screen behavior matters; shared isolated Server+Agent+tmux runtime in CI | Ordered event/frame/byte assertions, fault/resize/reconnect sequence, process or isolation observation, bounded logs and teardown; no “source contains logic” substitute |
| Real integrated provider, credentials, multiple Runs, Store CAS, recovery or service permissions | Typically `case` at `merged/staging` when a trusted integration lane is essential; `agent` only to judge an **independently attested existing** record | Trusted main-owned runner with isolated staging credentials, namespace and Store, real provider/Run and negative probes | Exact source SHA, Run/Attempt, execution and Store identity, state before/after, negative/failure-injection results, immutable signed/validated receipts |
| Main-only Actions identity, protected dispatch, publisher→reviewer handoff | `agent` if read-only authentic GitHub/Store receipts conclusively prove the property; `case` for an actual runnable end-to-end transition | Target `merged/main` **only if main identity is essential**, trusted workflow/GitHub API/Store readers | Exact main SHA, source and consumer Run/Attempt, workflow path/event/ref, authorized actor, output/receipt and negative checks; no unrelated “main green” |
| Actual deployment, VPN route, remote service, production safety, physical-device-only interaction | `case` plus an approved remote/device proof path when live behavior is required | `when: deployed` + environment; explicit `Acceptance / Cases` deployed run, authenticated deployment record; protected VPN runner/profile or approved device evidence path **only when actually implemented and authorized** | Deployed source SHA, environment, GitOps/workload UID/revision and image digests, read-only observed behavior, access boundaries, timestamp/Run/Attempt; mocked deployment or main merge cannot Pass |

**Mismatch to flag, not silently rewrite:** #1616 currently declares `when: deployed` + `method: agent` for SC-03–07, but the implemented explicit deployed path is `Acceptance / Cases` and the Agent eligibility path excludes deployed proof. Review each existing SC's wording and historical evidence, propose an explicit contract migration, and hold it `Pending` until an authenticated, executable route exists. Changing a live Plan changes its digest; use an Issue discussion and preserve old receipts.

## Which environment may execute?

| Environment / authority | Allowed work | Not sufficient for |
|---|---|---|
| Developer Agent's **isolated worktree** | Source review, `./gates/run --list/--describe/--validate`, narrow safe Gates/unit tests, `./e2e/run --list`, `./e2e/run --validate`, controlled dev-browser exploration | Formal full-stack E2E, privileged provider/Store/production access, automatic trusted Issue update |
| Approved **CI full-stack-local** | Exact-SHA `./e2e/run acceptance` using `e2e/acceptance/cases/<issue>/<SC>/`; Browser/Protocol/Runtime verifiers; isolated Server/Agent/tmux lifecycle and artifact capture | Real remote deployment identity, privileged production access or platform-specific physical hardware not present in runner |
| Trusted **merged staging integration** | Isolated real-provider/Store/security integration using protected credentials and exact staging SHA, when the approved lane exists | Main-only identity and production state; nonexistent staging lane cannot be substituted with a main canary |
| Authenticated **main-only lane** | Minimal main-specific workflow identity/dispatch observation | Generic cross-component behavior that could be proven in PR/staging; deployment evidence |
| Explicit **deployed / remote / device** lane | Read-only environment/device observation only with approved identity, network and safe probe model | Local simulation, unverified release tag, mock, or screenshot without trusted provenance |

Repository policy: **do not run the full E2E suite or full-stack Acceptance Case on a developer machine**; see `e2e/README.md`. Do not use `npx playwright test`, `CI=true` or direct runtime invocation to bypass it. Cases are run through the canonical CI/Actions interface, not by the model with production secrets. The source-aligned local runner is currently `full-stack-local` **in authorized CI**; `remote-staging` and `remote-production` execution profiles are specified but not generally enabled. An authenticated deployment identity path alone does not prove remote behavior.

## Per-SC execution procedure

1. **State the predicate.** Write one observable outcome and at least one concrete assertion (include a negative/failure case when it is part of the promise). Split an SC if code-policy proof and real-integrated behavior need different timing/methods. Avoid acceptance criteria that merely describe implementation.
2. **Inventory prerequisites.** Which exact source SHA, OS/architecture, browser/input/device, tmux/network, provider credentials, Store namespace, GitHub permissions or deployed identity must exist? Identify which runner or tool can actually access them. Check the current `e2e/run` inventory and Case support rather than assuming every Agent sandbox has a browser, Docker, privileged Linux, VPN or model API.
3. **Choose earliest safe `when` and executable `method`.** Prefer `pr` where equivalent reliable evidence exists; only use merged staging/main/deployed for properties that need those boundaries. If the proof is runtime behavior, require a Case and its source-aligned manifest; if an existing read-only authenticated receipt truly proves it, Agent may assess that receipt.
4. **Preflight locally, safely.** Run available narrow Gates/tests, inspect failures, use controlled dev-browser checks where relevant; record unresolved prerequisites. This helps implementation but **does not** automatically project a formal SC Pass.
5. **Run the authoritative proof.** For Agent proof use `Agent / SC Acceptance` and its exact target context. For Case proof create `e2e/acceptance/cases/<issue>/<SC>/case.yaml` and verifier(s), run `Acceptance / Cases`/`Acceptance / Case Smoke` as eligible through trusted CI and `./e2e/run acceptance`. Let the owning runner set up and tear down the runtime; the Case manifest must match the Issue stage.
6. **Evaluate and freeze evidence.** Verify target SHA, Issue/SC contract digest, Case revision/tree SHA (for Cases), workflow Run ID/Attempt, method, stage/environment, real assertion results, and immutable artifact/record links. The trusted ingester/projector alone updates `Acceptance Report` and the SC checkbox. Developer/Case/model code must not edit them.
7. **Handle missing capability explicitly.** Missing runner, credentials, VPN, device, Case, artifact or observable assertion = `Pending` with a named prerequisite/owner and next proof step. Observed product assertion false = `Fail`; infrastructure inability to execute is not automatically product Fail. `N/A` requires a legitimate non-applicability reason, not “cannot run locally”. Do not move the stage to main or broaden to Full E2E just to make a workflow green.

## Evidence checklist / handoff

For every SC, write down: **expected → action/input → actual observation → verdict**; the exact target SHA and source/Issue/SC digest; the specific Gate/test/Case verifier and decisive assertion; approved execution environment/profile; workflow Run/Attempt and artifact or code-path references; negative/failure/cleanup observations where relevant; and any evidence gap. Redact secrets, tokens, private routes and user terminal content.

A screenshot or Playwright trace backs a UI assertion but is not the sole trust anchor. A passing workflow, CI check or model-generated summary is not itself SC Pass. A prototype is design review, not production proof. An old SHA or mismatched deployment cannot establish current-SHA acceptance.

## Canonical owners and discovery

- SC authoring, stage selection and lifecycle: `nession-writing-requirements/SKILL.md` and `docs/architecture/acceptance-sc-format.md`.
- Method/parser constraints: `scripts/acceptance-plan.mjs`, `scripts/acceptance-executor.mjs` and `scripts/requirement-acceptance.mjs`.
- Case schema, verifier types, runner evidence, remote limitations: `docs/architecture/acceptance-cases.md`, `e2e/README.md`, `e2e/acceptance/contract/cases.mjs` and `e2e/run`.
- UI proof: `nession-web-design/SKILL.md`; CI/Gate scope: `nession-gates/SKILL.md`, `nession-cicd/SKILL.md` and `nession-workflows/references/acceptance-orchestration.md`.

When these owners change, revise this **selection guide** accordingly; never make this reference an independent executable policy owner.
