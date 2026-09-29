SET LOCAL statement_timeout='60s';

-- Generation 2 exporters acknowledge by row ID, which is unsafe after coalescing.
-- Stop the old process before migrating; surviving old writes fail visibly.
ALTER FUNCTION require_writer_generation_2() RENAME TO require_writer_generation_3;
CREATE OR REPLACE FUNCTION require_writer_generation_3() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('krine.writer_generation', true) IS DISTINCT FROM '3' THEN
        RAISE EXCEPTION 'Krine storage requires writer generation 3; stop the old server and upgrade';
    END IF;
    RETURN NEW;
END;
$$;

-- One durable slot per logical record bounds unfinished-attempt delivery.
-- Each retained decision payload includes every immutable verification transition.
DELETE FROM delivery_outbox older USING delivery_outbox newer
WHERE COALESCE(older.logical_id,older.id)=COALESCE(newer.logical_id,newer.id)
  AND (older.revision,older.id)<(newer.revision,newer.id);
UPDATE delivery_outbox SET logical_id=id WHERE logical_id IS NULL;
ALTER TABLE delivery_outbox ALTER COLUMN logical_id SET NOT NULL;
ALTER TABLE delivery_outbox ADD CONSTRAINT delivery_outbox_logical_unique UNIQUE(logical_id);
CREATE INDEX operations_unfinished ON operations(id) WHERE state<>'final';
