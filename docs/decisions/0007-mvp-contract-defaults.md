# ADR 0007: MVP contract defaults and engineering discretion

**Status:** Accepted

## Context

The product invariants and MVP scope provide enough direction to implement Krine. Unspecified contracts should be resolved through sensible engineering defaults and documented as they become concrete. Routine choices do not require founder approval.

## Decision

Proceed with these defaults:

| Area | MVP default |
| --- | --- |
| Proofs | A 60-second lifetime, single-use for one logical action attempt, bound to the action and source IP. Reject IP mismatches initially. |
| Challenge | The authoritative backend check can return `CHALLENGE_REQUIRED`. The browser completes verification, then the application retries the protected request/check for the same logical action. |
| Events | Accept arbitrary JSON customer properties within a validated event envelope. Support idempotent retries. Successfully acknowledged events affect applicable metrics in subsequent checks. |
| Identity | Limit relationships to clients, backend-known users and observed IPs. Retain Krine session context. Defer probabilistic client graphs. |
| Metrics | Start with a small useful built-in catalog and a few derived scores. Choose and refine the set during implementation; document each metric's meaning and missing-data behavior. |
| Versioning | Use draft → publish. Published policy versions are immutable and restorable. Metric semantic changes require explicit versions and upgrades. |
| Providers | Use a generic capability abstraction with one default challenge provider and one IP provider. Add custom HTTP support only if it fits without substantial extra scope. |
| Retention | Choose and document configurable defaults during implementation. Advanced retention/privacy tooling remains deferred. |
| Failures | Make checks idempotent and safe to retry after a timeout. Distinguish evaluated decisions from local SDK fallback. Default fallback is `allow`, with global and per-check overrides. |

SDK signatures, wire formats, storage, transaction boundaries, runtime placement, provider selection and configuration values remain engineering decisions. Keep defaults easy to change through focused configuration and replaceable boundaries. Preserve documented public behavior when evolving shipped contracts.

## Consequences

- A proof belongs to one logical action attempt. Transport retries recover the same attempt; challenge completion advances it. Neither authorizes an additional action. A final decision remains stable across retries.
- A timeout can leave the check outcome unknown. Retry recovery must survive the proof's initial expiry for the documented retry window. Reusing an operation key with different business inputs is an error; verified challenge evidence is a permitted continuation input.
- Successful event acknowledgement includes visibility to applicable decision metrics. It does not require every dashboard or analytical view to update synchronously.
- Local fallback expresses the application's configured availability policy. It must remain distinguishable from a Krine evaluation and must not hide an explicit denial or invalid proof.
- Idempotent checks do not make the customer's business operation idempotent. The application must prevent repeated execution of the same protected action.
- Implementation can proceed without resolving every entry in `../open-questions.md` first. Record durable architectural choices in ADRs and update the relevant contract documentation as code is added.

This ADR refines [ADR 0003](0003-backend-authoritative-decisions.md), [ADR 0004](0004-metrics-first-class.md) and [ADR 0005](0005-modular-providers.md). Their trust, metric and provider principles remain in force.
