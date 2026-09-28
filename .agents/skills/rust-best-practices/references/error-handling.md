# Error Handling

## Contents

- [Prefer `Result`](#prefer-result-avoid-panic)
- [Avoid production `unwrap` and `expect`](#avoid-unwrap-and-expect-in-production-paths)
- [Library errors with `thiserror`](#thiserror-for-library-errors)
- [Application context with `anyhow`](#anyhow-for-binaries-and-operational-boundaries)
- [Translation and observation](#error-translation-and-observation)
- [Async errors](#async-errors)

Rust makes fallibility explicit. Good Rust error handling keeps that explicitness
useful: typed errors for libraries, context at application boundaries, and no
surprise panics in normal control flow. The named libraries below are subject to
the dependency adoption boundary in `../SKILL.md`; preserve established error
handling unless adoption or migration is authorized.

## Prefer `Result`, Avoid Panic

Return `Result<T, E>` when the caller can recover, retry, report, or choose a
fallback.

```rust
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
enum DivideError {
    #[error("divisor must not be zero")]
    ZeroDivisor,
}

fn ratio(numerator: f64, divisor: f64) -> Result<f64, DivideError> {
    if divisor == 0.0 {
        return Err(DivideError::ZeroDivisor);
    }
    Ok(numerator / divisor)
}
```

Use `panic!`, `todo!`, `unimplemented!`, and `unreachable!` only when crashing is
intentional: tests, impossible invariants, prototype placeholders, or bugs that
must not be recovered from.

## Avoid `unwrap` and `expect` in Production Paths

Prefer pattern matching, `let-else`, or `?`.

```rust
#[derive(Debug, thiserror::Error)]
enum EnvelopeError {
    #[error("missing delimiter")]
    MissingDelimiter,
    #[error("missing payload")]
    MissingPayload,
}

fn payload(input: &str) -> Result<&str, EnvelopeError> {
    let Some((_, payload)) = input.split_once('|') else {
        return Err(EnvelopeError::MissingDelimiter);
    };

    if payload.is_empty() {
        return Err(EnvelopeError::MissingPayload);
    }

    Ok(payload)
}
```

`expect` is acceptable when failure is provably impossible and the message states
the invariant, not when it merely repeats the operation.

```rust
let token = "12".parse::<u8>().expect("literal `12` is a valid u8");
assert_eq!(token, 12);
```

## `thiserror` for Library Errors

Libraries should expose concrete error types that callers can match, inspect, or
convert.

```rust
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest field `{0}` is missing")]
    MissingField(&'static str),
    #[error("invalid manifest version: {0}")]
    InvalidVersion(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
```

Use nested errors to preserve layers without erasing details.

```rust
# #[derive(Debug, thiserror::Error)]
# #[error("invalid manifest")]
# pub struct ManifestError;
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("manifest error: {0}")]
    Manifest(#[from] ManifestError),
    #[error("transport error: {0}")]
    Transport(#[from] std::io::Error),
}
```

## `anyhow` for Binaries and Operational Boundaries

`anyhow` is useful at binary entry points, scripts, CLIs, and operational glue
where the user needs context more than typed matching.

```rust
use anyhow::{Context as _, Result};

fn load_settings(path: &std::path::Path) -> Result<String> {
    std::fs::read_to_string(path)
        .with_context(|| format!("failed to read settings from {}", path.display()))
}
```

Avoid exposing `anyhow::Result` from libraries unless the crate is explicitly an
application framework or plugin host where typed errors are not part of the API.

## Error Translation and Observation

Use `map_err` when changing error types. Use `inspect_err` for logging or metrics
without changing the error, only at the layer responsible for that observation.
Keep the translated error in the same domain as the failed operation and retain
its useful cause through `Error::source` rather than discarding it:

```rust
#[derive(Debug, thiserror::Error)]
enum PortError {
    #[error("invalid port `{input}`: {source}")]
    InvalidPort {
        input: String,
        #[source]
        source: std::num::ParseIntError,
    },
}

fn parse_port(input: &str) -> Result<u16, PortError> {
    input
        .parse::<u16>()
        .inspect_err(|err| tracing::debug!(%err, "port parse failed"))
        .map_err(|source| PortError::InvalidPort {
            input: input.to_owned(),
            source,
        })
}

assert_eq!(parse_port("8080").unwrap(), 8080);
let error = parse_port("not-a-port").expect_err("non-numeric ports are rejected");
assert!(
    std::error::Error::source(&error)
        .is_some_and(|source| source.is::<std::num::ParseIntError>()),
    "port errors must preserve their integer parsing source"
);
```

## Async Errors

Use the actual runtime bounds rather than adding blanket constraints.
[`tokio::spawn`](https://docs.rs/tokio/latest/tokio/task/fn.spawn.html) requires
both the future and its output to be `Send + 'static`; it does not require them
to be `Sync`. Local task APIs can support non-`Send` futures. Keep concrete errors
when callers need typed handling. At an application boundary, this common erased
error also includes `Sync` for interoperability with error-reporting libraries,
not because spawning itself requires it:

```rust
type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

async fn refresh_index() -> Result<(), BoxError> {
    Ok(())
}
```

Do not use `Box<dyn Error>` inside library APIs by default. It erases information
callers may need.
