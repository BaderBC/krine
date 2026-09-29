SET LOCAL statement_timeout='60s';
-- Older processes cannot maintain receipt coverage or the shared retention target.
ALTER FUNCTION require_writer_generation_4() RENAME TO require_writer_generation_5;
CREATE OR REPLACE FUNCTION require_writer_generation_5() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('krine.writer_generation', true) IS DISTINCT FROM '5' THEN
        RAISE EXCEPTION 'Krine storage requires writer generation 5; stop the old server and upgrade';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE INDEX operations_captured_decision ON operations((envelope->>'decision_id'));
CREATE TABLE application_observation_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    tracked_since bigint NOT NULL
);
INSERT INTO application_observation_state(singleton,tracked_since)
    VALUES(true,(extract(epoch FROM clock_timestamp())*1000)::bigint);
CREATE TABLE application_observations (
    kind text NOT NULL CHECK(kind IN ('client_evidence','backend_event','check_attempt')),
    check_name text NOT NULL DEFAULT '',
    record_id text NOT NULL,
    received_at bigint NOT NULL,
    basis text NOT NULL CHECK(basis IN ('tracked','retained_history')),
    PRIMARY KEY(kind,check_name),
    CHECK ((kind='check_attempt' AND check_name<>'') OR (kind<>'check_attempt' AND check_name=''))
);
INSERT INTO application_observations(kind,record_id,received_at,basis)
    SELECT 'client_evidence',payload->>'event_id',at,'retained_history'
    FROM delivery_outbox WHERE kind='event' AND payload->>'provenance'='browser'
    AND payload->>'name'='browser.context'
    ORDER BY at,id LIMIT 1;
INSERT INTO application_observations(kind,record_id,received_at,basis)
    SELECT 'backend_event',id,accepted_at,'retained_history' FROM events
    ORDER BY accepted_at,id LIMIT 1;
INSERT INTO application_observations(kind,check_name,record_id,received_at,basis)
    SELECT DISTINCT ON (envelope->>'check') 'check_attempt',envelope->>'check',
    envelope->>'decision_id',accepted_at,'retained_history' FROM operations
    ORDER BY envelope->>'check',accepted_at,id;

CREATE TABLE analytical_retention (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    days integer NOT NULL CHECK(days BETWEEN 2 AND 3650),
    requested_days integer NOT NULL CHECK(requested_days BETWEEN 2 AND 3650),
    expired_before bigint NOT NULL DEFAULT 0
);
INSERT INTO analytical_retention(singleton,days,requested_days) VALUES(true,30,30);
CREATE TABLE analytical_cleanup (
    table_name text PRIMARY KEY CHECK(table_name IN ('history','history_v2')),
    retired boolean NOT NULL DEFAULT false,
    cutoff bigint NOT NULL DEFAULT 0,
    baseline bigint,
    next_cleanup bigint NOT NULL DEFAULT 0
);
INSERT INTO analytical_cleanup(table_name) VALUES('history'),('history_v2');
