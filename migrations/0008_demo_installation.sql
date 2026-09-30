-- This metadata is written only by the isolated, stopped-writer demo importer.
-- No runtime endpoint can mark customer records as sample data or import history.
CREATE TABLE demo_import_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    dataset_id text NOT NULL,
    generator_version text NOT NULL,
    seed text NOT NULL,
    range_from bigint NOT NULL CHECK (range_from >= 0),
    range_to bigint NOT NULL CHECK (range_to >= range_from),
    manifest_hash text NOT NULL,
    owner_id text NOT NULL,
    completed_at bigint
);
CREATE TABLE demo_import_chunks (
    name text PRIMARY KEY,
    sha256 text NOT NULL,
    store text NOT NULL CHECK (store IN ('postgres', 'clickhouse')),
    rows bigint NOT NULL CHECK (rows >= 0)
);
