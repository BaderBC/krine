SET LOCAL statement_timeout='60s';
-- This is a stopped upgrade. An old process cannot authenticate a shared session
-- or write after the control-plane authority model changes.
ALTER FUNCTION require_writer_generation_5() RENAME TO require_writer_generation_6;
CREATE OR REPLACE FUNCTION require_writer_generation_6() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('krine.writer_generation', true) IS DISTINCT FROM '6' THEN
        RAISE EXCEPTION 'Krine storage requires writer generation 6; stop the old server and upgrade';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
DROP TABLE admin_sessions;
CREATE TABLE operator_access (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    installation_id text NOT NULL,
    installation_secret_digest text NOT NULL DEFAULT '',
    bootstrap_consumed_at bigint,
    local_enabled boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 1
);
INSERT INTO operator_access(installation_id) VALUES('installation_' || replace(gen_random_uuid()::text,'-',''));
CREATE TABLE operator_audit_retention (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    started_at bigint NOT NULL DEFAULT (extract(epoch FROM clock_timestamp())*1000)::bigint,
    expired_before bigint NOT NULL DEFAULT 0
);
INSERT INTO operator_audit_retention(singleton) VALUES(true);
CREATE TABLE operators (
    id text PRIMARY KEY,
    name text NOT NULL CHECK(octet_length(name) BETWEEN 1 AND 128),
    sign_in_name text NOT NULL UNIQUE CHECK(sign_in_name ~ '^[a-zA-Z0-9_.-]{1,64}$'),
    role text NOT NULL CHECK(role IN ('viewer','editor','admin')),
    state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','disabled')),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
    credential_digest text NOT NULL,
    created_at bigint NOT NULL,
    last_sign_in_at bigint
);
CREATE INDEX operators_page ON operators(created_at DESC,id DESC);
CREATE TABLE operator_recovery_grants (
    id text PRIMARY KEY, digest text NOT NULL UNIQUE, reason text NOT NULL,
    created_at bigint NOT NULL, expires_at bigint NOT NULL,
    consumed_at bigint, revoked_at bigint
);
CREATE INDEX operator_recovery_grants_expiry ON operator_recovery_grants(expires_at,id);
CREATE TABLE operator_sessions (
    id text PRIMARY KEY, digest text NOT NULL UNIQUE, csrf text NOT NULL,
    operator_id text REFERENCES operators(id),
    recovery_grant_id text REFERENCES operator_recovery_grants(id),
    generation bigint NOT NULL,
    created_at bigint NOT NULL, expires_at bigint NOT NULL, revoked_at bigint,
    CHECK ((operator_id IS NULL) <> (recovery_grant_id IS NULL))
);
CREATE INDEX operator_sessions_actor ON operator_sessions(operator_id,created_at DESC,id DESC);
CREATE INDEX operator_sessions_expiry ON operator_sessions(expires_at,id);
CREATE INDEX operator_sessions_recovery_grant ON operator_sessions(recovery_grant_id) WHERE recovery_grant_id IS NOT NULL;
ALTER TABLE admin_mutations DROP CONSTRAINT admin_mutations_pkey;
ALTER TABLE admin_mutations ADD COLUMN actor_id text NOT NULL DEFAULT 'legacy_shared_administrator';
ALTER TABLE admin_mutations ADD PRIMARY KEY(actor_id,key);
CREATE TABLE administrative_audit (
    id text PRIMARY KEY, at bigint NOT NULL,
    actor_id text NOT NULL, actor_type text NOT NULL,
    actor_name text NOT NULL, action text NOT NULL,
    resource_type text NOT NULL, resource_id text NOT NULL,
    reason text, changes jsonb NOT NULL,
    mutation_key text
);
CREATE INDEX administrative_audit_page ON administrative_audit(at DESC,id DESC);
CREATE INDEX administrative_audit_actor ON administrative_audit(actor_id,at DESC,id DESC);
CREATE INDEX administrative_audit_resource ON administrative_audit(resource_type,resource_id,at DESC,id DESC);
ALTER TABLE policy_versions ADD COLUMN published_by jsonb;
ALTER TABLE provider_revisions ADD COLUMN created_by jsonb;
ALTER TABLE provider_tests ADD COLUMN actor_id text;
ALTER TABLE application_credentials ADD COLUMN created_by jsonb;
ALTER TABLE application_credentials ADD COLUMN revocation_actor jsonb;
ALTER TABLE relationship_audit ADD COLUMN actor_identity jsonb;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['checks','policy_versions','application_credentials','application_credential_bootstrap',
        'provider_revisions','provider_current','provider_tests','admin_mutations','relationship_audit',
        'operator_access','operator_audit_retention','operators','operator_sessions','operator_recovery_grants','administrative_audit',
        'analytical_retention','analytical_cleanup']
    LOOP
        EXECUTE format('CREATE TRIGGER operator_writer_generation BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION require_writer_generation_6()', t);
    END LOOP;
END;
$$;
