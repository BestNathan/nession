# OperationSurface

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [visual language](../../visual-language.md) → [patterns](../patterns.md)

OperationSurface is the shared **depth grammar** for a deliberate operation: create or edit a declaration, confirm a risky transition, configure attach. It does not introduce another overlay primitive. It names the anatomy every existing operation surface already shares, so the Web dialog, the App full-height page and the App sheet read as one product.

The surface owners are already decided and remain so:

- Web: the shared `Dialog` / `AlertDialog` family and its `overlay-surfaces` contract (#3142);
- App: `AppOperationPage` and `AppSheet` (#3089);
- the operation body and action grammar: `web/src/components/ui/operation-surface.tsx` (#3137).

## Purpose

An operation is a **draft with a consequence**. The surface should make three things unambiguous:

1. what is being operated on;
2. what will happen when the primary action runs;
3. how to leave without committing.

Everything else — field grouping, validation, read-only evidence — comes from [ConfigurationForm](configuration-form.md) or [ResourceDetail](resource-detail.md).

## Anatomy

```text
surface (Dialog / AppOperationPage / AppSheet)
  close / Back owner        one leave, owned by the primitive or the App header
  title                     the surface's own name, `title` role
  lead                      one quiet sentence stating the consequence
  body
    FormSection(s)          named sections
    OperationError          surface-level action failure, if any
  action footer
    OperationActions        secondary ... primary
```

An operation may confirm a destructive action (`AlertDialog`) or present a non-destructive form. In both cases the hierarchy is the same: one title, one local body, one action line.

## States

| Condition | Presentation |
|---|---|
| Editing | Title + lead + sections; primary enabled per the domain's validity |
| Busy | Primary shows its busy copy and both actions disable; the body stays mounted |
| Field invalid | Field error stays on its `FormField`; the operation action stays the commit point |
| Action failed | `OperationError` in the body/actions, with the draft preserved |
| Destructive confirm | `AlertDialog`, explicit object name, destructive primary isolated from Cancel |
| App pushed confirm | The App's one Back leaves; there is no second Cancel with the same meaning |

## Progressive disclosure

The first view states the operation and its consequence. Advanced configuration is a named section, not an equal-weight wall of controls. A deeper operation (the Sandbox's explicit Enter confirmation) is a peer state with its own title and action line; it does not open a second overlay above the first.

## Web vs App

| | Web | App |
|--|-----|-----|
| Surface | Centered `Dialog`; `AlertDialog` for destructive confirm | `AppOperationPage` fullscreen (create/settings) or `AppSheet` (quick action) |
| Header | Dialog title + close button | One `AppPageHeader` with Back; the title is the depth's name |
| Scroll | One dialog body is the scroll owner; header/footer stay | One middle body scroll owner; safe-area footer |
| Actions | Sticky footer, secondary before primary | Persistent footer, primary reachable; Back is the only leave |
| Dismissal | Escape / outside / close according to the primitive | Back / sheet dismissal according to the App |

The App must not render a dialog-shaped operation as a shrunken Web modal, and Web must not grow an App full-height page. Both compose the same body grammar.

## Visual contract

- The title uses the same `title` role as any other surface name; a dialog title does not invent a smaller heading.
- One close/Back owner per depth. A Cancel control in the body either commits no change and stays in place, or is the host's leave — never a second Back.
- Exactly one scroll owner. The header and action footer do not scroll away from the body.
- A sticky footer is opaque and reaches the surface's padding edge.
- One primary action. Secondary actions precede it; destructive actions do not sit adjacent to a safe action without separation.
- Field errors stay on fields; only an operation-level failure uses `OperationError`.
- The body is not a second navigation layer: no tabs that push history inside a dialog unless that operation explicitly owns that depth.

Executable form: `data-recipe="operation-surface"` and `data-recipe-part="operation-*"` on the host surface and body; `design/contracts/patterns/operation-surface.json` records the stable scroll/wrap/touch constraints.

## Anti-patterns

- a second header or sticky bar inside the operation body;
- a nested full-height scroll region under the host's scroller;
- Cancel and Back offered as two names for one leave on App;
- two primary buttons, or a destructive action rendered as a secondary ghost beside Save;
- a validation summary that repeats every field error;
- reimplementing a dialog as a custom fixed layer to get a "mobile feel".

## Relationship to overlay-surfaces

`overlay-surfaces.md` owns which surface role presents an operation and the shared stacking/focus/dismissal/portal rules. OperationSurface is downstream: it owns the body hierarchy and action grammar inside that surface. It must not restate the overlay layer order, and it must not fork the primitive.

## Code owner and consumers

- `web/src/app/experiences/app/AppOperationPage.tsx` — App full-height operation and sheet (#3089).
- `web/src/components/ui/operation-surface.tsx` — shared lead/action/error parts (#3137).
- `web/src/components/ui/dialog.tsx` / `alert-dialog.tsx` — Web surface primitives; title role in `overlayStyles.ts` (#3142).

First consumers:

- Project Create/Settings/Rename/Delete (`ProjectDialogs.tsx`, `AppProjectFormSurface.tsx`);
- the Sandbox Enter confirmation and composer actions;
- the Session details editor's action line as the existing reference.
