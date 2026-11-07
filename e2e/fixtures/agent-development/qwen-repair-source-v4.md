# Qwen Repair Fixture v4

This is an inert, intentionally bounded source-edit target for the real
Developer -> Reviewer changes_requested -> resumed Developer -> Reviewer
approved chain of Nession Issue #2961 (parent #1664 SC-17). It is not a
product configuration file, a Provider prompt, an Acceptance verdict, or a
replacement for source-aligned staging proof.

## Fixture state

implementation: pending
verification: missing

## Required final content

A published version of this fixture is complete only when it contains all
three lines below exactly:

implementation: qwen-verified
verification: complete
review: pending

If any of those lines is missing or differs, the published change is
incomplete and must be repaired before approval.

The Developer may change the `implementation` and `verification` markers.
The `review` marker is owned by the authenticated Reviewer: the Developer
must never modify it, and a Developer-edited `review:` value is a review
violation.
