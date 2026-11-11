# ResourceDetail

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [visual language](../../visual-language.md) → [patterns](../patterns.md)

ResourceDetail is the shared **content grammar** for a surface that tells the user what a resource is or what state a capability is actually in. It is used by two different hosts:

- a standalone **resource destination** (Project Detail), where Nession chooses the shell and navigation;
- a **Session-context capability** (Sandbox Inside), where the capability owns the domain facts and the Workspace owns the host chrome.

The two hosts keep different shell owners. They share the internal hierarchy — identity, scope, observed facts, resource groups and recovery — so the same product reads as one system even though the surrounding navigation differs.

This is not a universal page component. A host keeps its own Back/header, scroll owner, navigation and width policy. The recipe owns only the content region's hierarchy and its measurable relationships.

## Purpose

Help the user answer, without reconstructing the system in their head:

- what resource or capability state is in front of them;
- which part is a declaration, which part is observed reality;
- what is healthy and quiet, and what genuinely needs attention;
- what they can do next, without competing primary actions.

Typical surfaces:

- Project Detail (a declaration of resources and Session presets);
- Sandbox Inside (the Agent's observed effective policy and execution identity);
- a Session's Workspace detail (runtime facts plus the editable work context);
- a truthful unavailable/unknown capability state.

## Product context

ResourceDetail is **content**, not navigation. It does not create a permanent tab, a second header, a capability ranking or a Workspace destination. A represented resource does not automatically gain navigation presence.

```text
host shell / Back / navigation     stays with the host
  └─ ResourceDetail content region
       identity + quiet scope
       observed facts / resource groups
       local actions / recovery
```

When the host already names the surface (the App's one page header, for example), the content renders `context` mode: it keeps description and actions and does not repeat the name. There is still exactly one title for the depth.

## Anatomy

```text
DetailSurface
  DetailHeader
    eyebrow            optional quiet kind, e.g. "Project"
    title              the surface's own name
    badges             state/identity chips that belong to the name
    meta               technical identity under the name
    description        one quiet scope sentence
    actions            top-right local actions
    header actions     one local action row

  DetailSection        named fact group
    title              quiet section heading
    section action     optional local action

  DetailFacts
    DetailFact         label + value, inline or stacked
  DetailGroup
    resource row       plain row at rest
  DetailEmpty          absence, in the interface's voice
  DetailNote           supporting explanation that must not compete
```

### Detail vs editable state

A read-only fact is a `DetailFact`: a label and a value. It must not be wrapped in an input-shaped box, a disabled field, a fieldset or a button unless the fact is genuinely an action. Effective Sandbox policy therefore reads as observed facts, not as the editable composer with disabled controls.

Editable configuration belongs to [ConfigurationForm](configuration-form.md). The two recipes may appear on the same host, but a read-only projection must not borrow the form's field treatment to prove it is "structured".

### Resource rows

A row that describes a resource is plain: alignment, a title role, quiet metadata and status do the grouping. A row that **is** an action may gain one background shift on hover/focus. It must not stack border + background + radius + shadow to advertise itself.

Long paths, digests and ids wrap through `break-all` at the value's own role; they do not force horizontal page overflow.

## States

| Condition | Presentation |
|---|---|
| Loading | Quiet status text owned by the host; do not invent skeleton facts |
| Healthy / observed | Facts are readable but visually restrained; no success badge needed |
| Empty / absent | `DetailEmpty` invites the next action or states the absence without decorative boxes |
| Degraded / invalid | The affected section gains local emphasis; the rest of the surface stays quiet |
| Unavailable / unknown | Truthful reason in the header description; no borrowed previous state |
| Optional | The section keeps its place, but its description and empty state do not compete with required identity |

A check reports facts; it must not turn them into success decoration. Healthy infrastructure stays quiet.

## Progressive disclosure

The first view carries identity, scope and the facts needed to understand the current state. Deeper groups (related Sessions, other panes, a prepared-root explanation, a raw policy payload) stay below or behind their own section rather than becoming equal-weight cards.

Do not show every optional fact at the same emphasis merely because the schema contains it. An optional section may be present but visually quieter than the identity and current state.

## Tokens

| Part | Role |
|---|---|
| Surface title | `chromeSansRole('title')` |
| Eyebrow | `chromeLabelRole('caption')` + muted |
| Meta | Experience role chosen by the caller (often `chromeMonoRole('metadata')`) + muted |
| Description / empty | `chromeSansRole('secondary')` + muted |
| Section heading | `chromeSansRole('secondary')` |
| Fact label | `chromeSansRole('caption')` + muted |
| Fact value | `chromeSansRole('body')`, technical values `chromeMonoRole('code')` |
| Resource title | `chromeSansRole('primary')` |
| Supporting note | `chromeSansRole('caption')` + muted |
| Local actions | Experience `control.*` through shared Buttons |

No feature-local palette, radius family, elevation or type scale. The row/background vocabulary resolves through Semantic surface tokens.

## Web vs App

| | Web | App |
|--|-----|-----|
| Host | Main-region destination or Workspace content | One App page header / pushed depth |
| Width | Reading column may use a local max width | Full content width, stacked |
| Title | The content names the surface | The host header names it; content uses `context` mode |
| Sections | Same rhythm and roles | Same roles at App density |
| Actions | Local action row / top-right icon | Touch-sized actions; primary stays reachable |

The App must not render a second header bar inside the content. If the host header already names the Project, the content omits the repeated identity and keeps the description and actions.

## Visual contract

- The title role is the surface's own name; a fact never uses the title role.
- Section headings are quieter than the title and do not compete with the current work.
- Read-only facts have no input chrome: no border, no background field, no disabled control.
- A section is separated by rhythm first. A repeated editable row may use one background shift; a fact group does not need a container.
- Metadata never outweighs the item it describes; status color is local to the state it reports.
- One dominant action per local region; secondary actions stay secondary.
- Long text wraps without horizontal overflow and without hiding its own beginning.

Executable form: `data-recipe="resource-detail"` plus `data-recipe-part="detail-*"` on the shared owner. Corresponding parts must resolve the same typography/material relationships in independent consumers. `design/contracts/patterns/resource-detail.json` records the stable wrap/overflow constraint and maps each `detail-*` part to its approved typography role; `e2e/tests/browser/ui-contract-assertions.spec.ts` checks those roles on the real Project and Sandbox fixtures (#3138).

## Anti-patterns

- a feature-local `Section`/`EmptyRow`/`boxClass` fork per resource page;
- every fact in its own bordered card, so hierarchy depends on containers;
- a read-only policy rendered as disabled inputs, suggesting an edit path that does not exist;
- the page name at the `primary` role while a capability title uses `title`;
- repeating the name in a host header and again in the content on App;
- a success badge for a healthy resource that needs no attention;
- a "capability dashboard" of equally weighted tiles.

## Code owner and consumers

`web/src/components/ui/resource-detail.tsx` owns the recipe. It lives in the shared UI layer because both `product` (Project, Session) and `capabilities` (Sandbox) consume the same relationship, and the layer model does not let a capability import product presentation. It is domain-agnostic: it knows roles and anatomy, not Project, Sandbox or Session semantics.

First consumers:

- `web/src/product/project/components/ProjectDetail.tsx`;
- `web/src/capabilities/sandbox/components/SandboxInsideView.tsx`,
  `SandboxEffectivePolicy.tsx`, `SandboxExecutionDetails.tsx` and
  `SandboxUnavailableView.tsx`;
- `web/src/product/session/components/SessionDetails.tsx` as the existing reference.
