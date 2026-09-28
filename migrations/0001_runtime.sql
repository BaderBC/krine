CREATE TABLE checks (
    name text PRIMARY KEY, description text NOT NULL, draft jsonb NOT NULL,
    draft_revision bigint NOT NULL DEFAULT 1, active_version bigint,
    restored_from_version bigint, created_at bigint NOT NULL, updated_at bigint NOT NULL
);
CREATE TABLE policy_versions (
    check_name text NOT NULL REFERENCES checks(name), version bigint NOT NULL,
    policy jsonb NOT NULL, published_at bigint NOT NULL, restored_from_version bigint,
    PRIMARY KEY(check_name, version)
);
CREATE TABLE entities (
    kind text NOT NULL, id text NOT NULL, client_id text,
    first_seen bigint NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY(kind,id)
);
CREATE TABLE associations (
    id text PRIMARY KEY, digest text NOT NULL, client_id text NOT NULL, user_id text NOT NULL,
    metadata jsonb NOT NULL, created_at bigint NOT NULL, revoked_at bigint,
    revocation_reason text, revoked_by text
);
CREATE INDEX associations_client ON associations(client_id,created_at);
CREATE TABLE association_audit (
    id bigserial PRIMARY KEY, association_id text NOT NULL REFERENCES associations(id),
    at bigint NOT NULL, action text NOT NULL, reason text NOT NULL
);
CREATE TABLE events (
    id text PRIMARY KEY, digest text NOT NULL, envelope jsonb NOT NULL,
    accepted_at bigint NOT NULL, projected boolean NOT NULL DEFAULT false,
    seq bigserial NOT NULL UNIQUE
);
CREATE INDEX events_accepted ON events(accepted_at);
CREATE TABLE projection_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    run_id text NOT NULL DEFAULT '', generation text NOT NULL DEFAULT '',
    watermark bigint NOT NULL DEFAULT 0
);
INSERT INTO projection_state(singleton) VALUES(true);
CREATE TABLE operations (
    id text PRIMARY KEY, digest text NOT NULL, proof_digest text NOT NULL UNIQUE,
    accepted_at bigint NOT NULL, retry_until bigint NOT NULL,
    envelope jsonb NOT NULL, response jsonb, detail jsonb
);
CREATE INDEX operations_accepted ON operations(accepted_at,id);
CREATE UNIQUE INDEX operations_decision ON operations((response->>'decision_id'));
CREATE TABLE admin_sessions (
    digest text PRIMARY KEY, csrf text NOT NULL, expires_at bigint NOT NULL
);
CREATE TABLE admin_mutations (
    key text PRIMARY KEY, digest text NOT NULL, response jsonb NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE outbox (
    id text PRIMARY KEY, kind text NOT NULL, at bigint NOT NULL, payload jsonb NOT NULL,
    exported_at bigint
);
CREATE INDEX outbox_pending ON outbox(at) WHERE exported_at IS NULL;
