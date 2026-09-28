# ADR 0003: Backend-authoritative checks

**Status:** Accepted direction

## Context

Browser code is attacker-controlled. Allowing the frontend to authoritatively identify a user, provide sensitive business context or decide whether an action is allowed creates obvious bypasses.

## Decision

For protected browser actions:

- client-side code contributes evidence and obtains fresh interaction proof;
- backend-originated data provides authoritative user/business context;
- the backend performs the authoritative Krine check;
- the backend obeys/enforces the resulting decision.

The exact protocol remains unresolved.

## Consequences

- direct calls to application endpoints cannot bypass Krine merely by skipping frontend decision code;
- user identity enrichment comes from backend authority;
- a Krine check adds a backend-side dependency to protected actions;
- outage behavior must therefore exist in the server SDK.
