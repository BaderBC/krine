# ADR 0012: Durable application credentials

**Status:** Accepted

## Context

Applications need to rotate and revoke browser keys and server secrets from
Application connection. Environment-only authentication would restore a revoked
credential on restart. A retried creation must not become a secret-retrieval API.
One installation still serves one project with one administrative role.

## Decision

Store credential identities and lifecycle in PostgreSQL. A credential has one
class: browser or server. Generate new values from 32 random bytes with distinct
`pk_` and `sk_` prefixes. Store SHA-256 digests for authentication, retaining the
browser-safe public value only for browser keys. A unique digest across both
classes prevents a public value from also being a server secret. Labels are
bounded; there are no per-key scopes, roles or origin overrides. The deployment's
exact browser origin allowlist applies to every browser key.

Bootstrap browser, server and administrator credentials must be distinct; a
browser key must never expose an administrator password either.

Import the existing environment pair once, atomically with a permanent bootstrap
marker. Preserve that marker and revoked rows indefinitely. Revocation, restart,
and changed environment values never cause another import. Fresh installations
therefore work with the existing deployment setup, while operators rotate keys
through authenticated administration. Environment settings remain required for
deployment compatibility but stop granting authority after the first import.

Every application request checks current credential class and active state in
PostgreSQL. There is no authorization cache and no per-request usage write. The
authenticated durable credential ID is available to handlers for provenance.
After revocation commits, later authentication checks fail. An already
authenticated in-flight request may finish; revocation does not cancel requests
or invalidate previously issued client/session/proof material. PostgreSQL failure
produces an explicit availability error, never environment-based authentication.

Create and revoke use the existing cookie, CSRF and 24-hour mutation identity
contract. Only the original committed creation response reveals a server secret.
The mutation ledger stores the credential ID, never its secret. A retry returns
current metadata and `secret_status: "unrecoverable"`; operators revoke and
replace a credential if the first response was lost. Browser values remain
retrievable because they are public. Revocation retains timestamp and the single
administrator actor and cannot be undone; create a replacement instead.

Credential lists are bounded and cursor-paginated, including revoked entries.
Setup chooses the oldest active browser credential deterministically, returns
its ID and active counts, and returns a null key when none remain. It never
claims the environment key is still active.

## Consequences

PostgreSQL is on the browser and server authentication paths as well as durable
enforcement. Revocation is consistent across replicas without cache invalidation.
High-entropy secrets need no password hashing work factor; SHA-256 digests do not
permit practical offline recovery.

Upgrading an environment-only deployment requires stopping every old server
before migrating and starting this version. An old binary cannot honor durable
revocation. Preserve PostgreSQL state and its bootstrap marker during backup and
restore; deleting the marker is not a supported key-rotation procedure.
