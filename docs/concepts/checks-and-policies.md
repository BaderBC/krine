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

## Policy editor

The primary policy interface is no-code and visual.

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

Challenge is an intermediate policy outcome.

The policy asks for a normalized verification capability.

The selected provider performs the concrete verification.

After verification, policy evaluation may continue toward a final allow/deny result.

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
