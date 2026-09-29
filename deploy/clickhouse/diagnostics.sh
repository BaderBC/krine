#!/bin/sh
set -eu

# Exact names and identifying comments from ClickHouse v26.8.11.7-lts SystemLog.h.
# Numeric suffixes are its schema-rotation archives; other names are never managed.
catalog() {
    cat <<'LOGS'
retire|metric_log|Contains history of metrics values from tables system.metrics and system.events, periodically flushed to disk.
retire|trace_log|Contains stack traces collected by the sampling query profiler.
retire|query_thread_log|Contains information about threads that execute queries, for example, thread name, thread start time, duration of query processing.
retire|query_views_log|Contains information about the dependent views executed when running a query, for example, the view type or the execution time.
retire|part_log|This table contains information about events that occurred with data parts in the MergeTree family tables, such as adding or merging data.
retire|background_schedule_pool_log|Contains history of background schedule pool task executions.
retire|text_log|Contains logging entries which are normally written to a log file or to stdout.
retire|error_log|Contains history of error values from table system.errors, periodically flushed to disk.
retire|query_metric_log|Contains history of memory and metric values from table system.events for individual queries, periodically flushed to disk.
retire|asynchronous_metric_log|Contains the historical values for system.asynchronous_metrics, once per time interval (one second by default).
retire|iceberg_metadata_log|Contains content of Iceberg metadata files.
retire|delta_lake_metadata_log|Contains content of Delta metadata files.
retire|opentelemetry_span_log|Contains information about trace spans for executed queries.
retire|processors_profile_log|Contains profiling information on processors level (building blocks for a pipeline for query execution.
retire|asynchronous_insert_log|Contains a history for all asynchronous inserts executed on current server.
retire|backup_log|Contains logging entries with the information about BACKUP and RESTORE operations.
retire|s3queue_log|Contains log entries with information about files processed by the S3Queue engine.
retire|blob_storage_log|Contains logging entries with information about various blob storage operations such as uploads and deletes.
retire|aggregated_zookeeper_log|Contains statistics (number of operations, latencies, errors) of ZooKeeper operations grouped by session_id, parent_path and operation. Periodically flushed to disk.
retire|zookeeper_log|This table contains information about the parameters of the request to the ZooKeeper server and the response from it.
retire|zookeeper_connection_log|Contains history of ZooKeeper connections.
retain|query_log|Contains information about executed queries, for example, start time, duration of processing, error messages.
retain|crash_log|Contains information about stack traces for fatal errors. The table does not exist in the database by default, it is created only when fatal errors occur.
LOGS
}

case "${1:-}" in
    --grants)
        printf '%s\n' '<query>GRANT SELECT(database, name, engine, comment, engine_full) ON system.tables</query>'
        printf '%s\n' '<query>GRANT SYSTEM FLUSH LOGS ON *.*</query>'
        catalog | while IFS='|' read -r mode name comment; do
            if [ "$mode" = retain ]; then
                printf '<query>GRANT ALTER TTL, ALTER SETTINGS ON system.%s*</query>\n' "$name"
            else
                printf '<query>GRANT DROP TABLE ON system.%s*</query>\n' "$name"
            fi
        done
        ;;
    --maintain)
        export CLICKHOUSE_PASSWORD
        CLICKHOUSE_PASSWORD=$(cat /run/secrets/clickhouse_password)
        query() {
            clickhouse-client --host 127.0.0.1 --user krine_bootstrap --log_queries=0 "$@"
        }
        # Preparation rotates incompatible definitions before inventorying archives.
        query --query 'SYSTEM FLUSH LOGS query_log, crash_log'
        # Retire costly collectors before scheduling retained archive expiry.
        catalog | while IFS='|' read -r mode name comment; do
            tables=$(query --param_name="$name" --param_comment="$comment" --query "
                SELECT name,
                    match(engine_full, 'table_readonly = (true|1)(,|$)'),
                    match(engine_full, 'TTL event_time [+] toIntervalDay[(]7[)]( SETTINGS|$)')
                FROM system.tables
                WHERE database = 'system' AND engine = 'MergeTree'
                    AND comment = concat({comment:String}, char(10), char(10), 'It is safe to truncate or drop this table at any time.')
                    AND (name = {name:String} OR match(name, concat('^', {name:String}, '_[0-9]+$')))
                ORDER BY name FORMAT TSV")
            [ -n "$tables" ] || continue
            printf '%s\n' "$tables" | while IFS="$(printf '\t')" read -r table readonly bounded; do
                # Defense in depth before interpolating an SQL identifier.
                case "$table" in
                    "$name") ;;
                    "$name"_*)
                        number=${table#"${name}_"}
                        case "$number" in ''|*[!0-9]*) exit 1 ;; esac
                        ;;
                    *) exit 1 ;;
                esac
                if [ "$mode" = retire ]; then
                    query --query "DROP TABLE IF EXISTS system.$table SYNC"
                    printf 'Retired upstream diagnostic table system.%s\n' "$table"
                else
                    if [ "$readonly" = 1 ]; then
                        query --query "ALTER TABLE system.$table MODIFY SETTING table_readonly = 0"
                    fi
                    if [ "$bounded" != 1 ]; then
                        # Archives loaded read-only have no background worker yet.
                        # Persist the mutation now; the normal server restart runs it.
                        query --query "ALTER TABLE system.$table MODIFY TTL event_time + INTERVAL 7 DAY DELETE SETTINGS materialize_ttl_after_modify = 1, alter_sync = 0"
                        printf 'Applied seven-day diagnostic retention to system.%s\n' "$table"
                    fi
                fi
            done
        done
        unset CLICKHOUSE_PASSWORD
        ;;
    *) echo 'Usage: clickhouse-diagnostics.sh --grants|--maintain' >&2; exit 1 ;;
esac
