CREATE TABLE provider_revisions (
    capability text NOT NULL, revision bigint NOT NULL, provider text NOT NULL,
    enabled boolean NOT NULL, config jsonb NOT NULL, secret text,
    status text NOT NULL, message text NOT NULL, checked_at bigint, created_at bigint NOT NULL,
    PRIMARY KEY(capability, revision)
);
CREATE TABLE provider_current (
    capability text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0
);
INSERT INTO provider_current(capability) VALUES ('ip_intelligence'), ('verification');
CREATE TABLE provider_tests (
    digest text PRIMARY KEY, capability text NOT NULL, candidate_digest text NOT NULL,
    revision bigint NOT NULL, status text NOT NULL, message text NOT NULL,
    checked_at bigint NOT NULL, expires_at bigint NOT NULL
);
ALTER TABLE operations ADD COLUMN state text NOT NULL DEFAULT 'claimed';
ALTER TABLE operations ADD COLUMN fence bigint NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN lease_until bigint;
ALTER TABLE operations ADD COLUMN history_revision bigint NOT NULL DEFAULT 0;
UPDATE operations SET state='final', history_revision=1 WHERE response IS NOT NULL;
CREATE TABLE challenge_steps (
    id text PRIMARY KEY, operation_id text NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    rule_id text NOT NULL, provider_revision bigint NOT NULL,
    binding text NOT NULL, created_at bigint NOT NULL, deadline bigint NOT NULL,
    status text NOT NULL DEFAULT 'pending', token_digest text UNIQUE,
    verification_uuid text NOT NULL, result text, detail text,
    UNIQUE(operation_id,rule_id)
);
CREATE TABLE verification_transitions (
    operation_id text NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    sequence bigint NOT NULL, at bigint NOT NULL, challenge_id text, state text NOT NULL,
    detail text NOT NULL, PRIMARY KEY(operation_id,sequence)
);
ALTER TABLE outbox ADD COLUMN logical_id text;
ALTER TABLE outbox ADD COLUMN revision bigint NOT NULL DEFAULT 1;
UPDATE outbox SET logical_id=id;
CREATE INDEX outbox_logical ON outbox(logical_id,revision DESC);
CREATE TABLE analytical_migrations (name text PRIMARY KEY, cursor_kind text NOT NULL DEFAULT '', cursor_id text NOT NULL DEFAULT '', completed boolean NOT NULL DEFAULT false);

-- The single-host upgrade stops the previous server first. Fail closed if an
-- old process survives: it cannot claim attempts or acknowledge revisioned exports.
CREATE FUNCTION require_writer_generation_2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('krine.writer_generation', true) IS DISTINCT FROM '2' THEN
        RAISE EXCEPTION 'Krine storage requires writer generation 2; stop the old server and upgrade';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER operations_writer_generation BEFORE INSERT OR UPDATE ON operations
    FOR EACH ROW EXECUTE FUNCTION require_writer_generation_2();
CREATE TRIGGER outbox_writer_generation BEFORE INSERT OR UPDATE ON outbox
    FOR EACH ROW EXECUTE FUNCTION require_writer_generation_2();

-- Old exporters must fail before sending revisioned payloads to the legacy
-- analytical table, not merely when acknowledging delivery afterward.
ALTER TABLE outbox RENAME TO delivery_outbox;
