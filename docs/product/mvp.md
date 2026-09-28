# MVP scope

The MVP should prove the full Krine product loop rather than maximize feature count.

## Required product loop

A developer should be able to:

1. self-host Krine;
2. install the browser and server TypeScript SDKs;
3. observe Krine client/session evidence;
4. send authoritative backend application events;
5. associate backend-known user information with Krine client context;
6. inspect built-in metrics;
7. configure at least one modular external intelligence provider;
8. create a named check such as `can_register`;
9. build its policy through a no-code UI;
10. include an optional challenge step through a provider;
11. request the protected action from a browser;
12. have the backend perform the authoritative Krine check;
13. obey the resulting decision;
14. inspect exactly why the decision happened.

## MVP product concepts

### Events

Backend application events plus client-side evidence.

### Entities

At minimum:

- client
- session
- user/account
- IP

Email and similar metadata may be attached or modeled as the implementation evolves; do not over-design the entity graph before implementation needs it.

### Metrics

- built-in primitive metrics;
- built-in derived metrics;
- read-only metric catalog in the dashboard;
- documentation and missing-data semantics for every metric.

User-authored metrics are not required for MVP.

### Checks

Application-defined named decisions such as `can_register`.

### Policies

No-code policy flows using metrics, current trusted backend inputs where appropriate, and normalized provider capabilities.

### Decisions

At minimum:

- allow
- deny

Challenge/verification is an intermediate policy outcome, not necessarily a final backend result.

### Explainability

Every decision must expose:

- check and policy version;
- path through the policy;
- relevant metric values;
- reason for the result.

## Explicitly not MVP

- machine learning training systems;
- cross-customer intelligence network;
- user-defined metrics;
- server-only/background checks without an interactive client proof;
- mobile SDKs;
- sandbox attack simulator;
- sophisticated historical replay;
- shadow rollout;
- gradual policy rollout;
- advanced manual-review queues;
- advanced privacy-management UI;
- enterprise organization/billing management;
- sophisticated graph visualization;
- arbitrary code execution in policies.

These may be added later if the product proves the need.

## MVP quality bar

"MVP" must not mean fragile.

The shipped flow should already handle:

- retries;
- proof replay attempts;
- missing provider data;
- provider outages;
- service outages;
- concurrent requests;
- invalid client input;
- understandable SDK errors;
- decision auditability.

Fewer capabilities are acceptable. Unclear security semantics are not.
