# Repository Scripts Instructions

This scope owns `scripts/` automation, deterministic validators, and repository helper mechanics.

## Ownership

- A script may own an executable repository rule; hooks/workflows invoke it instead of copying its rule list.
- If a deterministic rule is blocking-worthy and reusable, expose it through a stable Gate ID.
- Diagnostics do not become Gates merely because they can fail.
- Custom detectors need deterministic positive and negative self-tests.
- Failure output should name the violated invariant, owner, and repair path.

## Portability

Repository quality/bootstrap shell must work on supported developer hosts. Avoid accidental dependence on newer shell features unless the script explicitly owns that runtime requirement.

Quote paths, fail on unexpected state, and use temporary/private resources for tests.

## Validator changes

When modifying a checker:

1. state the invariant;
2. add/update a fixture proving a known violation is rejected;
3. include a valid counterexample;
4. run its self-test and Gate;
5. update prose only at the canonical owner.

Do not weaken an invariant to make the current change pass.
