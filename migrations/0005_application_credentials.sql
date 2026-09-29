CREATE TABLE application_credentials (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('browser', 'server')),
    label text NOT NULL CHECK (octet_length(label) BETWEEN 1 AND 128),
    source text NOT NULL CHECK (source IN ('bootstrap', 'administrator')),
    digest text NOT NULL UNIQUE,
    public_key text,
    created_at bigint NOT NULL,
    revoked_at bigint,
    revoked_by text,
    CHECK ((kind = 'browser') = (public_key IS NOT NULL)),
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX application_credentials_created ON application_credentials(created_at DESC, id DESC);
CREATE TABLE application_credential_bootstrap (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    imported_at bigint NOT NULL
);
