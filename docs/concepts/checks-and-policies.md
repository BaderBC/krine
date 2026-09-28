# Checks and policies

## Checks

A check is an application-defined trust decision.

Examples:

- `can_register`
- `can_login`
- `can_claim_trial`
- `can_create_api_key`
- `can_send_email`

Krine should not hard-code the business semantics of these names.

A check is a first-class object with its own:

- policy;
- versions;
- decision history;
- usage statistics;
- latency/error metrics;
- future testing/shadow data.

## Policy lifecycle

Policies follow a draft → publish workflow. Editing a draft does not change the active policy. Publishing activates an immutable version, and a previous published version can be restored without changing its definition.

Published policies preserve their metric semantics. A metric upgrade is explicit and becomes part of a new published policy version. See [MVP contract defaults](../decisions/0007-mvp-contract-defaults.md).

## Policy editor

The primary policy interface is no-code and visual. The [MVP editor](../product/information-architecture.md#policy-editor) uses ordered rules with disclosed boolean groups and explicit unknown-data paths. [ADR 0008](../decisions/0008-check-centered-information-architecture.md) records its publication, restoration and verification defaults; [core flows](../product/core-flows.md) describe the interactions.

Conceptually:

```text
can_claim_trial

if bot_score > 0.9
  deny

else if client.user_count_30d > 2
  require challenge

else
  allow
```

The interface should support ordinary policies without requiring scripting.

## Core policy building blocks

MVP-level concepts:

- AND / OR / NOT;
- compare metric values;
- compare trusted current backend inputs where needed;
- equality / ranges / thresholds;
- list membership;
- explicit known/unknown handling;
- allow;
- deny;
- require challenge.

Arbitrary code execution is not an MVP requirement.

## Challenge

Challenge is an intermediate policy outcome. When verification is required, the backend check returns `CHALLENGE_REQUIRED`; the application passes that requirement to the browser, which completes the selected provider's challenge.

The browser then retries the protected request, and the backend retries the Krine check with the verification result. This continues the same logical protected action toward a final allow/deny result. Challenge completion does not itself authorize the action.

The policy asks for a normalized verification capability; the selected provider performs the concrete verification.

## Check retries

Checks are idempotent for the same logical operation and safe to retry after a timeout. A transport retry recovers the same evaluation result. A challenge continuation advances that operation after verification, without granting authorization for another action.

Engineering defines the wire format, continuation mechanism and storage boundaries while preserving these semantics. The application remains responsible for preventing duplicate execution of its protected action.

## Explainability

The platform must retain enough information to show:

- policy version;
- path taken through the flow;
- conditions that matched;
- metric/input values involved;
- final result.

Example:

```text
can_claim_trial → DENY

client.user_count_30d = 7
condition requires <= 3
```

## Backend authority

For browser-originated protected actions, the backend performs the authoritative Krine check.

The browser does not decide whether an action is allowed.

The exact network protocol remains intentionally unspecified until implementation design.
