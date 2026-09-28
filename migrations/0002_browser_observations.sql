CREATE TABLE observed_ips (
    client_id text NOT NULL, session_id text NOT NULL, ip text NOT NULL,
    first_seen bigint NOT NULL, last_seen bigint NOT NULL,
    PRIMARY KEY(client_id,session_id,ip)
);
CREATE INDEX observed_ips_latest ON observed_ips(last_seen);
