# Overlay Surfaces

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) →
> [interaction/web.md](../../interaction/web.md), [interaction/app.md](../../interaction/app.md) →
> [visual-language.md](../../visual-language.md)

The cross-family contract for every surface that interrupts, anchors over, or
temporarily replaces the work region: dialogs, confirmations, sheets, operation
pages, tooltips, anchored menus/Selects and Popovers.

**This pattern owns presentation and interaction only.** It does not own the
business flow inside an Overlay: Attach still belongs to the Session operation
owner, Project forms to the Project owner, and Files/Env operations to their
capabilities. It also does not own the content hierarchy of those operations —
[#3137](https://github.com/BestNathan/nession/issues/3137) owns the
resource-detail/configuration/operation visual grammar, and this document only
decides which overlay family presents it.

## The six surface roles

| Role | User job | Use | Do not use |
|---|---|---|---|
| **Tooltip** | Name or explain a control without taking focus | Short, non-interactive text on hover/focus | Actions, long help, anything a pointer must enter |
| **Anchored choice** (Select, ContextMenu, DropdownMenu) | Pick from a bounded list attached to a trigger | The trigger already names the current value or target; one choice per row | Multi-field editing, content that outgrows the anchor, a list that should be a page |
| **Popover** | Brief contextual controls beside their trigger | One or two compact controls that stay in context | A form that needs scrolling, a decision that must block work |
| **Confirmation** (AlertDialog) | Interrupt for a consequential or destructive decision | One decision with explicit action and cancel; the safe action is the default | Data entry, long copy, a decision the user can defer into a page |
| **Simple dialog** | Short focused action that is not destructive | A handful of fields/choices that fit a compact surface | Multi-step editing, long lists, operations with child depths |
| **Complex operation** | Multi-step edit or creation over the current work | Web wide/standard dialog with an internal body scroll; App full-height operation depth | A confirmation, a menu, or a surface the user must keep beside the Terminal |

Rules that follow from the table:

- An anchored surface never becomes a full operation editor. If the content
  outgrows the anchor, the role is wrong — promote it to a Dialog/Operation.
- A modal is not a default container for actions. If the work can continue
  beside the surface, use an anchored surface; if the decision must block,
  use a confirmation.
- Destructive actions use the confirmation role; they never sit as an
  undisclosed side effect of another action.

The rows inside an anchored list are owned by [PopupMenu](popup-menu.md): an
**action** row keeps the 28px Web / 44px App single-line band, while a
**resource** row may wrap and grow with its identity/metadata. A resource list
may widen beyond a narrow trigger up to `experience.*.overlay.choiceMaxWidth`;
that growth does not change this document's portal, stacking or dismissal
contract.

## Web composition

```text
trigger / command
  → is the user choosing from a short list anchored to a control?
      yes → anchored choice (PopupMenu / Select)
  → must the work region be blocked for a decision?
      yes → confirmation (AlertDialog) for one consequential decision
            simple dialog for a short non-destructive action
  → is the operation multi-step, long, or scrollable?
      yes → complex operation (Dialog, centered, semantic size role)
```

### Semantic size roles

A centered overlay picks a **role**, never a pixel literal:

| Role | Token | Initial value | Typical use |
|---|---|---|---|
| Compact | `experience.web.overlay.compactMaxWidth` | 30rem | Confirmations, rename, short details |
| Standard | `experience.web.overlay.standardMaxWidth` | 40rem | Create Session, bounded forms |
| Wide | `experience.web.overlay.wideMaxWidth` | 45rem | Attach, Project create/settings, content-capable operations |

Every centered overlay is clamped by
`experience.web.overlay.viewportMaxWidth` / `viewportMaxHeight`; the clamp, not
the role, decides on a small viewport. Roles do not imply a fixed height.

## Anatomy and scroll ownership

```text
┌──────────────────────────────┐
│ Header — sticky, opaque      │  title/identity, close/back
├──────────────────────────────┤
│ Body — the sole scroll owner │  fields, lists, anchored controls
│                              │
├──────────────────────────────┤
│ Footer — sticky, opaque,     │  cancel + one primary action
│ flush with the surface edge  │
└──────────────────────────────┘
```

- Content takes its natural height until the viewport clamp applies. After
  that, the **body scrolls**; the header and footer do not.
- A sticky footer is an opaque band flush with the dialog's bottom edge, so
  content scrolling beneath it can never show through (#3128).
- A form inside the body must not create a second vertical scroller. Lists that
  need their own scroll (Env files, long choices) own a bounded region with a
  visible boundary and a single scroll axis.
- Long paths/URLs/addresses wrap or scroll horizontally inside their own field;
  the dialog itself never scrolls horizontally. A value the user may need in
  full has an inspect/copy affordance rather than a permanent ellipsis.

## App composition

| Intent | App presentation |
|---|---|
| Short one-action intent (e.g. quick Attach) | Bottom **sheet** over the mounted Terminal |
| Substantial create/edit/configuration | **Full-height operation page** with exactly one header/Back |
| Destructive confirmation | Small accessible **confirmation** surface |
| Anchored choice | Menu/Select over the current layer, at the App control band |

The Experience, not the viewport alone, selects the presentation. `?experience=app`
on a wide viewport keeps the App operation/page behavior; `?experience=web` on a
narrow viewport keeps the Web dialog/drawer behavior. A Back/cancel must preserve
the user's draft and the selected Session/Terminal until an explicit commit;
only the primary action commits.

## Visual grammar

- One **scrim** (`semantic.overlay-scrim`) for both Dialog and AlertDialog.
- One **surface** treatment: `popover` surface, `radius-surface`-family radius,
  `ring` border, `elevation-floating` shadow.
- One **title** role — the shared surface `title` typography role
  (`overlayTitleClass`) — one body text role, one action-band rhythm. The
  operation body and action grammar inside the surface are owned by
  [OperationSurface](operation-surface.md); they never fork the primitive. Warning/destructive meaning comes from the action variant and the
  message, never from an unrelated surface palette.
- Dialog and AlertDialog may keep different primitives (Base UI vs Radix) for
  their semantics. They must not keep different values: the shared vocabulary
  lives in `web/src/components/ui/overlayStyles.ts` and consumes tokens from
  `design/tokens/`.

## Portal, stacking and dismissal ownership

- **Layer order** is token-owned and explicit:
  `tooltip (experience.*.overlay.tooltipZ) > anchored popup
  (experience.*.overlay.anchoredZ) > dialog/alert
  (experience.*.overlay.dialogZ)`. A Select/Menu opened from a dialog must paint
  above that dialog; a tooltip may paint above the choice it explains.
- **A popup carries the Experience scope of the layer that opened it.** In App,
  menus, Selects, context menus, popovers and tooltips mount into the App popup
  container (`data-experience="app"`) so their rows resolve the App control band
  (44px touch floor). Web popups keep the default body mount.
- **A popup opened inside a modal mounts into that modal's own popup host.** The
  dialog content provides a host inside its floating tree (`dialog-popup-portal`),
  so the anchored layer inherits the dialog's Experience scope and remains inside
  the modal's focus trap and accessible subtree. A body-level container would be
  hidden by the modal's outside-content protection and sit outside the trap.
  This changes where the popup mounts, not its portal/stack owner: the same
  anchored layer still renders above the dialog.
- **Focus**: modal surfaces trap focus; anchored nonmodal surfaces do not.
  Escape closes the innermost owned layer first (tooltip → anchored choice →
  dialog), then the dialog; outside click dismisses dismissible layers but never
  a confirmation. Focus returns to the trigger after a nonmodal close and to a
  meaningful element after a modal close.
- **Cancel and outside dismissal never execute the primary action.** A
  destructive confirmation performs its action only through its explicit
  confirm control.
- **Labelling**: every modal surface has an accessible name; every anchored
  popup is linked to its trigger by the primitive; icon-only triggers keep an
  accessible name.

## Usage and ownership

```text
web/src/components/ui/*        generic primitives: Dialog, AlertDialog,
                               DropdownMenu, Select, ContextMenu, Popover, Tooltip
        ↓
product/app composition        chooses the role and owns the content/action flow
        ↓
capability / feature           supplies input + actions, never global chrome
```

- Shared generic behavior lives in `web/src/components/ui`; a product pattern
  chooses among the roles.
- The overlay system owns no domain state and no second form DSL.
- Extensions may contribute content/actions inside a surface; they may not
  define competing global chrome or stacking.

## Relation to #3137

#3137 owns what an operation page/detail/configuration says and how its content
is hierarchically organised. This pattern owns which overlay surface presents
that content, its size role, anatomy, scroll owner, stacking, dismissal and
focus. A change to one must not silently re-specify the other.

## Migration inventory (current behavior → target role)

| Surface | Current behavior | Target role | Owner |
|---|---|---|---|
| Session Attach | Wide Web dialog (720); App quick sheet + full-page configuration | Web complex operation / App sheet + operation depth | Session operation composition |
| Session Create | Standard Web dialog (640); App full-height operation | Web simple/complex operation by contents; App operation depth | `useCreateSessionForm` + composition |
| Project Create/Settings | Wide Web dialog (720); App full-height operation | Web complex operation / App operation depth | Project form composition |
| Project Rename | Compact Web dialog; App confirmation/dialog | Confirmation/simple dialog | Project dialogs |
| Project/Agent/Session delete | AlertDialog confirmation | Confirmation | Owner flow |
| Files create/rename/delete | Compact dialog or AlertDialog | Simple dialog / confirmation | Files capability |
| Env selection/edit | Select/popover + compact dialog | Anchored choice / simple dialog | Env capability |
| Workspace context menus | Anchored menu/Select | Anchored choice | Workspace composition |
| Tooltips on chrome controls | Tooltip | Tooltip | Shell/pattern owner |

The inventory is a map, not a mandate for bulk restyling: each row migrates when
its owner changes, and the proof is the browser Case for that surface.

## Anti-patterns

- A per-consumer `sm:max-w-[…]` literal where a size role exists.
- A dialog that scrolls its header/footer with the body, or a form with a second
  vertical scroller.
- A translucent sticky footer over scrolling fields.
- An anchored menu portalled outside its Experience scope, or painted under the
  dialog that opened it.
- A destructive action triggered by Cancel, outside click, or the default focus.
- Two primitives with different scrims/radii/typography for the same role.
- Treating the prototype as proof of production React behavior.

## Contracts and proof

- `design/contracts/patterns/overlay-surfaces.json` pins the shared scroll and
  touch constraints; size roles resolve from `design/tokens/experience/*`.
- `e2e/acceptance/cases/3142/SC-02..SC-05` prove the production Web/App flows,
  nested stacking/dismissal and the published prototype.
- `ui-contract-matrix` and the visual baselines remain the regression owners for
  the surfaces they already cover.
