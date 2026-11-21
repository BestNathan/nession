# UI Task Routing

This reference owns the **task classification and routing fixtures** for `nession-web-design`. It decides which Nession owners, optional Impeccable capabilities, shadcn/ui sources, and validation paths a UI task needs.

It does not own design truth. Owners are listed in [design-owners.md](design-owners.md); Impeccable states and claims are in [impeccable.md](impeccable.md); component mechanics are in [shadcn.md](shadcn.md).

## Inputs

Classify from the task, not from the files that happen to be open:

1. **Task kind** — new surface, redesign, critique, polish, responsive adaptation, component implementation, interaction/layout defect, renderer adapter, token/value change, review, or non-UI.
2. **Decision state** — is the product/design decision already approved by an Issue, contract, pattern, or linked prototype, or is it still unresolved?
3. **Affected owner layer** — Experience host, semantic recipe, capability-local composition, generic primitive, token, or renderer adapter.
4. **Available capabilities** — which optional tools are actually discoverable/executable (see [impeccable.md](impeccable.md)). Availability never changes the required Nession owner or validation.

## Decision procedure

```text
1. classify task kind
2. read the minimum canonical owners for that kind
3. decide whether a component decision exists -> shadcn.md
4. decide optional Impeccable capability (select / skip / unavailable)
5. run Nession Gates + canonical Chromium/Playwright proof as required
6. write the concise audit record
```

Do not select an optional capability before the owner and decision state are known; external advice must not invent the product decision.

## Task taxonomy

| Task kind | Read first | Component decision | Optional Impeccable | Required validation |
|---|---|---|---|---|
| New surface / new capability composition | product model, IA, interaction (web/app), composition, patterns | Check existing pattern/recipe, then [shadcn.md](shadcn.md) | `shape` when interaction/structure is still unresolved; skip when the Issue already approves the structure | `design-system-fast`, relevant full design/Web checks, Chromium/Playwright at the affected flow |
| Redesign of an existing surface | product model, IA, interaction, visual language, composition | If the redesign changes a repeated component, follow [shadcn.md](shadcn.md) | `critique` or `shape` when direction is not approved; skip when the approved direction is fully specified | same as new surface, plus before/after visual evidence |
| UX critique / heuristic review | relevant product/IA/interaction owners | normally none | `critique` / `audit` when available; otherwise record `docs-only` or `unavailable` | no Gate substitute; review conclusions remain advisory unless a Nession contract changed |
| Visual polish | visual language, spatial relationships, relevant pattern | only if a primitive or wrapper changes | `polish` when the surface is approved and the change is aesthetic; skip for mechanical token/contract edits | `design-system-fast`, relevant browser inspection |
| Responsive / App adaptation | composition, interaction/app, validation viewport matrix | only if a responsive primitive changes | `adapt` when target behavior is still being chosen; skip when the contract already fixes it | Chromium/Playwright at the affected viewport(s) |
| Component implementation / primitive gap | components, patterns, [shadcn.md](shadcn.md) | always | normally skip; implementation-only with settled design | `design-system-fast`, relevant Web tests, browser proof if the rendered result matters |
| Interaction / layout defect | composition (layout ownership), validation, affected owner | only if the fix needs a component change | `layout` or `critique` only after the owning contract is identified; skip when the defect is a contract violation with a known repair | reproducing browser flow plus relevant Gates |
| Renderer adapter / theme | renderer owner (`docs/design/terminal/*`, renderer docs) | no generic primitive substitution | skip generic visual advice until the renderer-owning boundary is identified | computed/rendered browser verification |
| Token / value change | tokens, generated artifacts, affected consumers | none | skip; this is a mechanical canonical-source change | design Gates; regenerate outputs through the owner |
| Review / verification only | validation, contracts, browser catalog | none | `audit` or `detect` may add advisory findings; never acceptance proof | the existing canonical Gate/browser evidence path |
| Non-UI change | none | none | not applicable | normal repository workflow |

## Optional capability selection

Select at most the capabilities the task needs. The smallest useful combination is preferred.

| Capability | Select when | Skip when |
|---|---|---|
| `shape` | The interaction or surface structure is genuinely unresolved and the Issue/owner does not specify it | An approved Issue, contract, pattern, or prototype already fixes the structure |
| `critique` | The task asks for a usability/UX review, or a redesign needs diagnosis before direction is set | The task is implementation-only or the approved contract already prescribes the outcome |
| `audit` | A broad accessibility/responsiveness/theming sweep is requested beyond repository Gates | A narrow, contract-bound fix already has a Nession Gate/validator |
| `layout` | Spacing/rhythm anomalies are visible but no existing contract explains them | A composition/spatial-relationship contract already names the repair |
| `adapt` | Responsive/App target behavior is still being chosen | The viewport contract already specifies the target |
| `polish` | Final visual-quality pass on an approved surface | The change is mechanical, structural, or still under design |
| `harden` | Edge cases (errors, i18n, overflow) are the requested scope on an approved surface | The defect has a specific owning contract (fix that instead) |
| `detect` | Optional advisory scan of changed source or a URL | The scan is being used as a Gate, acceptance proof, or CI enforcement |

Skipping a capability is normal. Record a skip only when the capability was materially considered (for example, a critique was requested but unavailable) and an unavailable state whenever the task expected the tool.

## Routing fixtures

Each fixture is a deterministic example. The expected decision is normative for this router; a reviewer can compare a real task against it directly.

| ID | Task | Required Nession owners | Impeccable decision | Component decision | Required validation |
|---|---|---|---|---|---|
| R-01 | Add a Details panel for a new capability inside Workspace | product model, IA, composition, patterns, validation | `shape` if the panel's interaction is unresolved; otherwise skip with reason | reuse `ResourceDetail`; add a primitive only if no installed source fits | `design-system-fast`, full design/Web checks, Chromium/Playwright at the capability flow |
| R-02 | Rework the Workspace navigation hierarchy | product model, IA, interaction/web, visual language, composition | `critique`/`shape` only while direction is unapproved; skip once the Issue approves a direction | follow [shadcn.md](shadcn.md) if a shared component changes | full design checks, browser flow, before/after visual evidence |
| R-03 | Tighten spacing between Settings cards | visual language, spatial relationships, composition | `polish` optional; skip for a mechanical token/class change | none | `design-system-fast` plus browser inspection |
| R-04 | App sheet overflows on a short landscape viewport | composition, interaction/app, validation viewport matrix | `adapt` optional while target behavior is open; skip if the contract fixes it | wrapper only if geometry ownership requires one | Chromium/Playwright at the affected viewport(s) |
| R-05 | Add a Table primitive for dense tabular rows | components, patterns, [shadcn.md](shadcn.md) | skip: implementation-only with settled design | add the official shadcn primitive, normalize it, keep it generic | `design-system-fast`, relevant Web tests, browser proof if rendered output matters |
| R-06 | xterm selection color ignores a semantic token | terminal/design renderer owner, tokens, validation | skip generic visual advice until the renderer adapter owner is identified | no generic primitive substitution | renderer-boundary computed/rendered browser verification |
| R-07 | Rename a semantic padding token | tokens owner, generated artifacts, consumers | skip: mechanical canonical-source change | none | regenerate through the owner; design Gates |
| R-08 | Review the onboarding flow's usability without changing code | product/IA/interaction, visual language | `critique`/`audit` selected only when active; otherwise record `docs-only` or `unavailable` | none | conclusions stay advisory; no Gate substitute |
| R-09 | Implement a flow already fixed by a linked prototype | the prototype's owning design docs plus prototype consistency | skip `shape`: the decision is made | follow [shadcn.md](shadcn.md) if components are needed | full Nession validation and browser flow |
| R-10 | Fix server retry logic | none (not a UI task) | not applicable | none | normal repository workflow |
| R-11 | A design-system Gate fails on layout ownership | composition §14, design Gate diagnostics | skip optional tools; repair the owner | none | re-run the failing Gate and the broader design checks |
| R-12 | An approved surface needs error/overflow/i18n hardening | affected pattern/contract, validation | `harden` optional when the surface is approved; skip when a specific owner contract covers the defect | only if the fix changes a shared primitive | affected Gates plus browser states |

## Negative fixtures (must be rejected)

| ID | Wrong decision | Why rejected | Correct decision |
|---|---|---|---|
| N-01 | Run `critique` on every UI edit | Optional capability becomes unconditional ceremony | Skip when the task is implementation-only or the owner already fixes the outcome |
| N-02 | Treat an Impeccable `SKILL.md` file as an available command | File presence is not host discovery or execution | Record `docs-only` unless the host exposes the command/skill |
| N-03 | Claim `detect` passed without running it | Reading tooling docs is not execution | Run it, or record `docs-only`/`not run` |
| N-04 | Use Impeccable spacing advice over the spatial-relationship contract | External advice cannot override a Nession owner | Follow the Nession contract; note the rejected advice if material |
| N-05 | Count optional tool output as the design Gate or browser proof | Validation is Nession-owned | Run the required Gates and canonical browser flow |
| N-06 | Install/upgrade Impeccable silently to complete a task | Tool installation is a consented environment change | Follow [impeccable.md](impeccable.md) and `nession-env`; record unavailability if not approved |
| N-07 | Use a physical iPhone/Safari screenshot as acceptance proof | Acceptance is Chromium + Playwright | Use the canonical browser runner/viewport matrix |
| N-08 | Copy a shadcn component table into the router | The live inventory is executable and changes | Query `just design-inventory` / the maintained reference |
| N-09 | Mark a critique finding as an Acceptance failure | Acceptance follows its own contract | Preserve the Issue's Acceptance method; advisory findings are separate |

## Deterministic contract assertions

A routing record is valid only when all of these hold:

- **A-01** It names exactly one primary task kind from the taxonomy.
- **A-02** It names the canonical Nession owner(s) read for that kind.
- **A-03** A selected Impeccable capability names the command and the observed availability state.
- **A-04** A materially considered but skipped capability names the reason.
- **A-05** An unavailable capability names the fallback and contains no execution claim.
- **A-06** Every UI task names its Nession validation (Gate(s) and browser flow where applicable).
- **A-07** No record allows an optional capability to replace a Gate or browser proof.
- **A-08** The audit record contains all five fields from the template below.

## Audit record

```text
Design route: owners=[...]; shadcn=[selected/skip: reason]; impeccable=[active: command | docs-only | skipped: reason | unavailable: reason]; validation=[gates + browser flow]; docs-only=[paths | none]
```

Examples:

```text
Design route: owners=[composition, validation]; shadcn=[skip: no component change]; impeccable=[skipped: contract already fixes viewport behavior]; validation=[design-system-fast, Chromium 390x844 + landscape]; docs-only=[none]
```

```text
Design route: owners=[patterns, validation]; shadcn=[selected: ResourceDetail reuse]; impeccable=[active: /impeccable shape]; validation=[design-system-full, capability browser flow]; docs-only=[none]
```

```text
Design route: owners=[interaction/web, visual-language]; shadcn=[skip: none]; impeccable=[docs-only: pinned critique guidance; command unavailable]; validation=[browser review only, no code change]; docs-only=[.claude/skills/nession-web-design/references/impeccable.md]
```

A routine, fully owner-specified edit still needs the first line; it does not need a narrative.
