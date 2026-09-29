SET LOCAL statement_timeout='60s';

-- Older writers do not coordinate relationship snapshots and must fail closed.
ALTER FUNCTION require_writer_generation_3() RENAME TO require_writer_generation_4;
CREATE OR REPLACE FUNCTION require_writer_generation_4() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('krine.writer_generation', true) IS DISTINCT FROM '4' THEN
        RAISE EXCEPTION 'Krine storage requires writer generation 4; stop the old server and upgrade';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE associations
    ADD COLUMN session_id text,
    ADD COLUMN credential_id text REFERENCES application_credentials(id),
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE INDEX associations_user_page ON associations(user_id,created_at DESC,id DESC);
CREATE INDEX associations_client_page ON associations(client_id,created_at DESC,id DESC);
CREATE INDEX associations_session_page ON associations(session_id,created_at DESC,id DESC);
CREATE INDEX associations_current_users ON associations(client_id,created_at,user_id) WHERE revoked_at IS NULL;

ALTER TABLE observed_ips
    ADD COLUMN id text,
    ADD COLUMN credential_id text REFERENCES application_credentials(id),
    ADD COLUMN last_credential_id text REFERENCES application_credentials(id),
    ADD COLUMN first_source text NOT NULL DEFAULT 'legacy',
    ADD COLUMN last_source text NOT NULL DEFAULT 'legacy',
    ADD COLUMN first_event_id text,
    ADD COLUMN last_event_id text,
    ADD COLUMN has_corrections boolean NOT NULL DEFAULT false,
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN revoked_at bigint,
    ADD COLUMN revocation_reason text,
    ADD COLUMN revoked_by text;
UPDATE observed_ips SET id='oip_' || md5(jsonb_build_array(client_id,session_id,ip)::text);
ALTER TABLE observed_ips ALTER COLUMN id SET NOT NULL;
ALTER TABLE observed_ips DROP CONSTRAINT observed_ips_pkey;
ALTER TABLE observed_ips ADD PRIMARY KEY(id);
CREATE UNIQUE INDEX observed_ips_active ON observed_ips(client_id,session_id,ip) WHERE revoked_at IS NULL;
CREATE INDEX observed_ips_client_page ON observed_ips(client_id,first_seen DESC,id DESC);
CREATE INDEX observed_ips_session_page ON observed_ips(session_id,first_seen DESC,id DESC);
CREATE INDEX observed_ips_ip_page ON observed_ips(ip,first_seen DESC,id DESC);

CREATE TABLE relationship_audit (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('backend','observed_ip')),
    relationship_id text NOT NULL,
    at bigint NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    actor text,
    revision bigint,
    relationship jsonb
);
CREATE INDEX relationship_audit_page ON relationship_audit(kind,relationship_id,at DESC,id DESC);
INSERT INTO relationship_audit(id,kind,relationship_id,at,action,reason)
    SELECT 'legacy_' || id,'backend',association_id,at,action,reason FROM association_audit;
DROP TABLE association_audit;

CREATE VIEW relationship_records AS
SELECT id,'backend'::text AS kind,client_id,session_id,user_id,NULL::text AS ip,
       created_at AS first_seen,created_at AS last_seen,'backend'::text AS source,
       credential_id,credential_id AS last_credential_id,'backend'::text AS first_source,
       'backend'::text AS last_source,NULL::text AS first_event_id,NULL::text AS last_event_id,
       revision,revoked_at,revocation_reason,revoked_by,metadata
FROM associations
UNION ALL
SELECT id,'observed_ip'::text AS kind,client_id,session_id,NULL::text AS user_id,ip,
       first_seen,last_seen,'browser_observation'::text AS source,
       credential_id,last_credential_id,first_source,last_source,first_event_id,last_event_id,
       revision,revoked_at,revocation_reason,revoked_by,'{}'::jsonb AS metadata
FROM observed_ips;

CREATE TRIGGER associations_writer_generation BEFORE INSERT OR UPDATE OR DELETE ON associations
FOR EACH ROW EXECUTE FUNCTION require_writer_generation_4();
CREATE TRIGGER observed_ips_writer_generation BEFORE INSERT OR UPDATE OR DELETE ON observed_ips
FOR EACH ROW EXECUTE FUNCTION require_writer_generation_4();
