# ConfigurationForm

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [visual language](../../visual-language.md) → [patterns](../patterns.md)

ConfigurationForm is the shared **editable content grammar** for a resource's configuration: Project identity/source/locations/image and a Sandbox policy's filesystem, network, process, resource and syscall groups. It owns the relationships between labels, controls, help, validation, sections and repeated rows. It does not own any domain's data, validation or action semantics.

The recipe exists because every control can be a valid primitive while the assembled form still belongs to a different visual family: one editor uses caption labels and fieldset borders, another uses `Label` and cards, and a third hand-writes help/error text at different roles. Those are one product job and need one owner.

## Purpose

Let a user read and edit a configuration without learning a second form language per capability:

- what each field is for;
- which fields are required, optional or currently unavailable;
- why a value is rejected, at the field that rejected it;
- which fields form one semantic section;
- which actions commit or leave the draft.

## Anatomy

```text
FormSurface                     one configuration region, one rhythm
  FormSection                   named group; optional description and action
    FormField                   label row + control + help + field error
      label                     shared Label primitive
      label action              optional count / secondary control
      control                    Input / Textarea / Select / Checkbox / editor
      description               quiet help
      error                     field-local destructive message
    FormGrid                    two related fields on Web; stacked on App
    FormRow                     repeated editable unit (location, KV entry)
  FormActions                   grouped local actions; secondary before primary
```

A section is a **named semantic group**, not a visual container. Do not wrap it in a fieldset, card or border just to make it a section; the heading and rhythm carry that meaning.

## States

| Condition | Presentation |
|---|---|
| Editable | Label, control and optional help; no error chrome |
| Disabled | Shared control disabled state; no custom grey literals |
| Field invalid | The field's own `FormField` error, at the field; `aria-invalid` on the control |
| Action invalid | `OperationError` at the operation level; never duplicated onto every field |
| Optional / empty | Empty-first: an empty section says what is absent without pretending an empty row exists |
| Unavailable implementation | Keep the measured status visible; disable the controls that depend on it and explain why |
| Busy | Shared button busy copy and disabled state; the draft stays on screen |

Validation belongs to the domain owner. The recipe only gives it one place to speak.

## Progressive disclosure

- Required identity stays visible; optional infrastructure sections are quieter and may be empty-first.
- Advanced controls stay in their own named section or deeper peer surface rather than gaining equal emphasis on first view.
- An optional group that is empty may omit its dynamic rows; it should not render a preset blank row.
- A deeper validation result belongs with the operation's action line, not in a global banner that displaces the form.

## Tokens

| Part | Role |
|---|---|
| Section heading | `chromeSansRole('secondary')` |
| Section description / help | `chromeSansRole('caption')` + muted |
| Field label | shared `Label` primitive (one owner for all consumers) |
| Field error | `chromeSansRole('caption')` + `text-destructive` |
| Repeated row surface | Semantic muted surface, one background shift |
| Controls | Experience `control.*` through shared Inputs/Selects/Buttons |
| Actions | Shared Button variants; secondary before primary |

No feature-local field geometry, label size, error color or row radius. #3136's compact row geometry remains a semantic variant of the shared field controls, not a per-consumer class fork.

## Web vs App

| | Web | App |
|--|-----|-----|
| Section rhythm | Named sections in the dialog/page body | Same named sections, stacked |
| Paired fields | Two related fields may share a row when the contents support it | Full-width stacked fields; landscape may pair only when the composition says so |
| Controls | `control.md` field band where the compact variant applies | Touch-sized fields and actions |
| Actions | Sticky dialog footer | One App page footer with the primary reachable |

The layout difference is an explicit composition variant (`locationsLayout="stacked"` / App operation page), not a set of local Tailwind forks inside each domain editor.

## Visual contract

- One label style for every form control in both Project and Sandbox.
- Help and field errors use one role; an error never becomes body text.
- A field's error sits with the field; an operation failure sits with the actions.
- A section is named and spaced; it is not a bordered box around fields.
- Repeated rows use one background shift and one rhythm, and may use a shared `FormRow`.
- All controls resolve their height from the Experience control vocabulary; the App keeps the touch floor.
- No horizontal overflow when a path, tag or identifier is long; the control wraps or scrolls intentionally.

Executable form: `data-recipe="configuration-form"` plus `data-recipe-part="form-*"` on the shared owner. `design/contracts/patterns/configuration-form.json` records the stable wrap/overflow and App touch constraint, the shared `controlHeightToken`, and the section/help/error typography roles; `e2e/tests/browser/ui-contract-assertions.spec.ts` checks them on the real Project and Sandbox fixtures (#3138). The field label is deliberately not a chrome role in the contract: its owner is the shared `Label` primitive, so the check compares it relationally between consumers.

## Domain boundaries

The recipe is domain-agnostic. It does not know what a Project Location, a Sandbox resource key or an environment profile is. Those semantics stay with their owners:

- `ProjectLocationsEditor` owns the location rows and their #3136 compact geometry;
- `SandboxKvEditor`/`SandboxKvRow` own native Key/Value suggestions and the Agent's measured availability;
- `SandboxStringListEditor` owns an explicit list's add/edit/remove path;
- each domain owns its draft, validation and submit action.

The recipe owns only how those parts read together.

## Anti-patterns

- one fieldset/card per section, making the form read as a configuration console;
- caption-sized labels in one editor and `Label` in another for the same job;
- a validation summary repeated above every failing field;
- an optional group shown with the same weight as required identity;
- a feature-local class fork for App stacking instead of the composition variant;
- a disabled control standing in for a read-only fact (that is [ResourceDetail](resource-detail.md)).

## Code owner and consumers

`web/src/components/ui/configuration-form.tsx` owns the recipe. It lives in the shared UI layer because both `product` (Project, Session) and `capabilities` (Sandbox, Environment) consume it.

First consumers:

- Project Create/Settings through
  `web/src/product/project/components/ProjectFormFields.tsx`,
  `ProjectLocationsEditor.tsx` and `ProjectDialogs.tsx`;
- the Sandbox Outside composer through
  `SandboxFilesystemFields.tsx`, `SandboxNetworkProcessFields.tsx`,
  `SandboxKvEditor.tsx`/`SandboxKvRow.tsx` and `SandboxSyscallProfile.tsx`;
- the Session work-context editor as the existing reference.
