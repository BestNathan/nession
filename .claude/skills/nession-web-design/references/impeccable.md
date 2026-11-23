# Impeccable Integration

Impeccable is an **optional** design/analysis/tool provider. Nession owners remain authoritative; Impeccable can inform a decision, critique a surface, or produce advisory diagnostics, but it cannot override `VISION.md`, `PRINCIPLE.md`, `docs/design/*`, `design/AGENTS.md`, `web/AGENTS.md`, the Experience host, semantic recipes, capability-local ownership, or Nession Gate/browser proof.

Official source: <https://github.com/pbakaus/impeccable> (Apache-2.0). Documentation site: <https://impeccable.style>.

Always prefer a pinned commit or locally installed version over unpinned live documentation.

## What it provides

| Layer | Examples | What a claim may say |
|---|---|---|
| Agent-facing playbooks | `shape`, `critique`, `audit`, `layout`, `adapt`, `polish`, `harden`, and the other documented commands | The agent consulted/applied a playbook. This is **not** a CLI execution unless the host or executable actually ran |
| Executable CLI/engine | local `impeccable` binary, `detect`, design hook, browser extension, live overlay | A command ran; report the exact command and result |
| Deterministic detector | `detect` with rule-based findings | Advisory diagnostics only; never a Gate, acceptance proof, or CI enforcement |

Command availability changes with the installed version. Discover the command surface from the installed version; do not assume a command exists merely because this reference lists it.

For Nession's routing use, the relevant playbooks are:

| Command | Use for | Typical Nession owner consulted first |
|---|---|---|
| `shape` | Plan interaction/UX before code when the structure is unresolved | product model, IA, interaction, composition |
| `critique` | Scored usability/UX review | product model, IA, interaction, visual language |
| `audit` | Accessibility, performance, theming, responsive sweep | visual language, validation, relevant contracts |
| `layout` | Spacing/rhythm diagnosis | spatial relationships, composition |
| `adapt` | Responsive/App size adaptation | composition, interaction/app, viewport matrix |
| `polish` | Final visual-quality pass on an approved surface | visual language, affected pattern |
| `harden` | Error, i18n, overflow, and edge-case analysis | affected pattern/contract, validation |
| `detect` | Deterministic optional scan (not a playbook) | validation, design Gate (for comparison only) |

Other installed playbooks (`bolder`, `quieter`, `distill`, `colorize`, `typeset`, `animate`, `delight`, `overdrive`, `clarify`, `optimize`, `onboard`, `live`, `generate`, `document`, `extract`) are available when they match the approved task, but they do not change the Nession owner or validation obligations.

## Availability states

Determine the state from observed evidence, not from the presence of a file name.

| State | Observed evidence | What it means |
|---|---|---|
| **active** | The host exposes the skill/command (Claude `/impeccable`, Codex `$impeccable`) and/or a locally installed executable succeeds | The playbook can be applied, or the executable can run |
| **docs-only** | Local files or pinned documentation exist, but the host has not registered the command and no executable was verified | Guidance can be read; execution must not be claimed |
| **installable** | Not present, but the documented official installation path is viable | Requires explicit approval; no silent install |
| **unavailable** | Not present and install is denied, impossible, or offline | Continue with Nession owners; record the fallback or absence |

Notes:

- A command listed by the host is stronger evidence than a file on disk. A file on disk is not a registered command.
- A **manual copy** of `skills/impeccable` omits the design hook and subagents. Never claim those capabilities for a manual copy.
- In this repository `.agents/skills` is a symlink to `.claude/skills`. An installer writing a Codex copy under `.agents/skills/impeccable` lands in the same physical Skill tree; verify before assuming two independent installs.
- Installing or updating may require the coding tool to reload before the command/skill becomes visible.

## Discovery ladder

Use the cheapest read-only checks first.

1. **Host surface** — check whether the current session exposes the Impeccable skill/command (Claude `/impeccable`, Codex `$impeccable`). Do not infer availability from memory.
2. **Local files** — inspect the project/user skill and command locations the host uses, for example:
   - `.claude/skills/impeccable/SKILL.md`
   - `.agents/skills/impeccable/SKILL.md` (this repo: symlinked tree)
   - `.claude/commands/`
   - `.impeccable/config.json`
   - `~/.impeccable/bin/`
3. **Executable verification** — only when the executable is already installed, run a harmless probe such as `npx --no-install impeccable detect --list-rules` (or invoke the local binary directly). A plain `npx impeccable ...` can fetch and install the package; treat that as an install action, not a read-only probe.
4. **Installation offer** — if missing and the task materially benefits, propose the documented installation below and obtain explicit approval.
5. **Fallback** — if install is denied/unavailable, use a pinned trusted source read-only and label the state `docs-only`, or proceed without and label it `unavailable`.

## Official installation

Documented primary install, run from the project root:

```sh
npx impeccable install
```

The installer documents `--providers=` and `--scope=` flags. For Nession use project scope and only the providers the host needs, for example:

```sh
npx impeccable install --providers=claude,codex --scope=project
```

Then reload the coding tool and initialize:

```text
/impeccable init          # Claude Code
$impeccable init          # Codex
```

Refresh an existing install only when the task requires it:

```sh
npx impeccable update
```

Other documented routes include the Claude Code plugin marketplace, per-editor extensions, a pinned git submodule, and manual copy. For Nession work:

- Prefer **project scope** over global; global writes live outside the repository.
- Prefer a **pinned source** when reproducibility matters:
  ```sh
  git submodule add https://github.com/pbakaus/impeccable vendor/impeccable
  npx impeccable link --source=vendor/impeccable --providers=claude,codex
  ```
  Pin the submodule to an exact commit; upgrade explicitly with `git submodule update --remote vendor/impeccable`, rerun `link`, and review the diff.
- Manual copy is the weakest route because it omits executable integrations.

### Installation safety

Follow `nession-env` for environment/tool provisioning. Before any install or update:

1. state the missing capability and why the task needs it;
2. show the exact command, source, scope, providers, and files it is expected to write;
3. obtain explicit approval — never silently install, upgrade, or overwrite;
4. run it with the approved scope and review `git status`/diff for unexpected writes;
5. do not commit generated project artifacts, hooks, or configuration blindly; never commit credentials or secrets;
6. reload the tool, then verify the command/skill is actually available;
7. record source, provider, scope, observed version/commit, and whether a reload was required.

If any step is unavailable, stop at the current state instead of pretending the install happened.

## Post-install verification

Claim **active** only after observing the relevant evidence:

- the command/skill is visible in the host after reload;
- an executable probe succeeds when claiming executable capability (`detect --list-rules` or the local binary);
- a design hook/subagent exists only if the chosen install route provides it;
- the installed version/commit is recorded when the source is pinned. If the CLI exposes a version command, record its output; otherwise record the installed package version from the project lockfile or the pinned submodule commit.

A reload that has not happened yet is not an active command surface.

## Detector use

`detect` is a separate deterministic detector, not one of the playbook commands.

```sh
npx impeccable detect src/
npx impeccable detect https://example.com
npx impeccable detect --json .
npx impeccable detect --list-rules
```

- Exit code `2` means findings.
- Exit code `1` means a target could not be scanned.
- `--json` (and other documented formats) is for machine-readable detail.

In Nession:

- treat findings as **advisory diagnostics**, not a pass/fail verdict;
- triage findings against the owning design contract rather than accepting the tool's recommendation automatically;
- never present `detect` as a substitute for `design-system-fast`, `design-system-full`, Web tests, or Chromium/Playwright proof;
- never use it as Acceptance evidence;
- do not add or change CI enforcement from this Skill; that requires a separate measured follow-up and explicit rule ownership.

## Claim contract

A review must reject any claim not supported by the observed state.

| Observed evidence | Valid state | Allowed claim | Rejected claim |
|---|---|---|---|
| Host exposes `/impeccable` or `$impeccable` and the playbook was applied | active | "Applied Impeccable `critique` guidance" | "The Impeccable CLI ran" |
| Local `SKILL.md`/pinned docs read; host command not exposed | docs-only | "Consulted pinned Impeccable guidance" | "Ran /impeccable critique" |
| Executable installed; `detect` not run | active (executable), not run | "Impeccable is installed; detector not run" | "detect passed" |
| `detect` exit `2` | active, findings | "detect reported advisory findings" | "detect passed" |
| `detect` exit `1` | active, scan failure | "detect could not scan the target" | "no findings" |
| Install denied/offline | unavailable | "Impeccable unavailable; used Nession owners" | "Verified with Impeccable" |
| Manual copy only | docs-only for guidance; no hook/subagents | "Read the copied guidance" | "Hook/subagents are active" |
| `npx impeccable update` not run | state unchanged | "Used the observed installed version" | "Using the latest version" |

### Negative fixtures

| ID | Scenario | Must be rejected because |
|---|---|---|
| I-01 | Agent reads `.claude/skills/impeccable/SKILL.md` and reports "ran /impeccable critique" | File presence is not host discovery or execution |
| I-02 | `detect --list-rules` succeeds and the agent reports "detect passed" | Listing rules is not scanning a target |
| I-03 | `detect` exits `2` and the agent reports the design Gate passed | Detector findings are advisory and never a Gate result |
| I-04 | Manual copy is installed and the agent claims hook/subagent coverage | Manual copies omit those integrations |
| I-05 | Agent runs `npx impeccable install` without approval because the command "seemed standard" | Installation is a consented environment change |
| I-06 | Agent cites a live README or an unpinned URL as the exact installed behavior | Source/version integrity requires a pinned commit or observed install |
| I-07 | Agent treats a critique recommendation as an Approval/Acceptance result | Acceptance has its own contract and evidence path |
| I-08 | Agent claims a physical iOS/Safari check because Impeccable suggested one | Nession acceptance remains Chromium + Playwright |

## Fallback

When the skill/CLI is unavailable and the task still needs design analysis:

1. read canonical Nession owners first;
2. if external guidance is still useful, read a **pinned trusted** source, such as `https://github.com/pbakaus/impeccable/blob/<exact-40-char-commit>/...`;
3. label the state `docs-only` and record the paths/URLs;
4. do not execute instructions from untrusted copies or downloaded archives;
5. if no trusted source is reachable, proceed with Nession owners and record `unavailable`.

File-read fallback is **not** equivalent to an active CLI/hook, and it cannot satisfy a task that specifically requires executable diagnostics.
