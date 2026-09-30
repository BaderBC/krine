# ADR 0021: Individual operators and attributable administration

**Status:** Accepted architecture; implementation under review

## Context

A shared installation password cannot establish who published a policy, changed
provider trust or corrected identity evidence. Enterprise operation needs named
access, least privilege, offboarding and inspectable administrative changes.
Operators are people administering Krine; they are unrelated to customer user
entities. This replaces the shared administrator authority in ADR 0008 while
preserving one installation, one company and entirely local operation.

## Decision

Use three fixed roles: Viewer investigates, Editor also changes checks and
relationships, and Admin also manages providers, application credentials and
operators. Recovery is a distinct, narrower authority, not another Admin role.
Every actual route and method, including query aliases and implicit HEAD, has an
explicit capability. Unregistered routes gain no authority. Application SDK
credentials and decision execution never enter the operator authorization gate.

A local operator has an immutable, case-sensitive ASCII sign-in name, a display
name and a server-generated 256-bit credential. Store only a domain-separated
digest bound to the operator ID and compare it in constant time. Arbitrary human
passwords are not accepted. A slow password KDF provides no additional guessing
resistance for these random credentials; accepting user-selected passwords would
require a new reviewed credential lifecycle and password-hashing decision.
Credentials appear once. Exact creation/rotation retries return the recorded
operator with `secret_status: unrecoverable`; they never generate or recover a
second secret. Role/state changes and rotation revoke all target sessions.

Sessions use an opaque HttpOnly, Secure, Strict SameSite, host-only cookie scoped
to `/v1/admin`, independent CSRF and an eight-hour absolute expiry. PostgreSQL
supplies authentication time and current operator/session state on every request.
No role is trusted from a browser or process cache. Duplicate authentication
cookies and security headers fail closed. A valid session lacking a capability
receives `403 insufficient_privilege`; it must not trigger a sign-in loop.

Before a privileged transaction, acquire a shared row lock on the authorization
singleton and validate current authority within that transaction. Access changes
acquire an exclusive lock from the outset. Never upgrade a shared lock. This
orders mutation and replay with revocation: a transaction already holding the
gate may finish first; once revocation commits, later work cannot use its old
session. An authorized read already in progress may finish; bytes already sent
cannot be recalled. Provider tests release locks over external work and recheck
authority before storing or returning a result. Their tokens bind the actor,
candidate, revision and expiry.

Mutation receipts are unique by `(actor_id, idempotency_key)`. Clients send the
original actor ID with an intent; it grants no authority, but prevents a pending
intent from silently changing authors after sign-in. Authorization precedes
receipt lookup. Historical shared receipts remain in an explicit legacy
namespace and cannot be claimed by a person. A later 401/403 does not establish
that an earlier ambiguous write failed.

Each durable administrative effect appends an allowlisted audit record in its
transaction, alongside its receipt when applicable. Replays append no duplicate
effect. Store immutable actor ID/type/name snapshot, action, resource, revision
or role/state changes, approved reason and PostgreSQL time. Never serialize
arbitrary request bodies, policies, provider configuration or secrets into audit.
Resource attribution remains on policy/provider versions, credentials and
relationship audit. Legacy attribution is null or the historical shared label,
never retrospectively assigned to a named person. Audit has an independent
365-day window and monotonic coverage floor. Its retention singleton is separate
from the authorization gate; cleanup releases ordinary receipt locks before its
independent access cleanup. Host setting changes are attributed to installation
configuration, not a signed-in person. Audit is not tamper-proof against a
trusted database or host administrator.

The installation secret authorizes one atomic first-Admin enrollment. Its consumed
marker survives restart and secret changes. A lost initial reveal uses recovery.
The host may arm one replacement recovery grant, valid for 15 minutes, using the
matching installation configuration, expected installation ID and a reason. The
command writes the token only to a new owner-only file in an owner-only directory;
it never migrates the database or starts HTTP. Redemption consumes it and grants
30 minutes of access to operator lifecycle and session revocation only. Arming a
new grant revokes previous recovery grants and sessions. Recovery cannot inspect
customer history, change policies, providers or application credentials. Never
allow the final active ordinary Admin to be disabled or demoted. Backup recovery
must invalidate restored sessions/grants and reconcile access changes since the
backup before opening ingress.

Migration 0009 requires a stopped upgrade. It removes the old session relation,
retains legacy receipt attribution and advances the database writer fence to
six for both runtime and administrative tables. Already-running old binaries
cannot authenticate old shared sessions or commit old control-plane writes.
Rollback requires restoring a compatible backup, not starting an old image.

## Consequences

Local access is the first independently reviewed unit. A later OIDC unit will
reuse these actor/session/capability contracts, with exact verified issuer and
subject, deliberate enrollment and locally assigned roles. It requires its own
protocol, provider-boundary and browser evidence. Until another ordinary sign-in
method is implemented, disabling local sign-in is rejected to avoid lockout.
No groups, custom roles, email merging, public signup or customer IAM are added.
The dashboard and deployment/demo/recovery helpers must migrate together before
this backend enters the main product branch. Existing installations need first
named enrollment; a shared-password login compatibility bypass is not retained.
