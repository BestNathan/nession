# Qwen Repair Fixture v2

This is an inert, intentionally bounded source-edit target for the real
Developer -> Reviewer changes_requested -> resumed Developer -> Reviewer
approved chain of Nession Issue #2946 (parent #1664 SC-17). It is not a
product configuration file, a Provider prompt, an Acceptance verdict, or a
replacement for source-aligned staging proof.

## Fixture state

implementation: pending
review: pending

## Authorized final state

After the authorized Developer change, this file must contain:

implementation: qwen-verified
review: pending

That is the only state the authenticated Reviewer may approve. The Developer
may change the `implementation` marker only. The `review` marker is owned by
the authenticated Reviewer: the Developer must never modify it, and a
Developer-edited `review:` value is a review violation.
