# Builder Pattern

## Contents

* [When to use a builder](#when-to-use-a-builder)
* [Struct, function, and method builders](#struct-builders-with-bonbuilder)
* [Overwritable setters](#overwritable-setters)
* [Builder versus type-state](#builder-vs-type-state)
* [Practical guidance](#practical-guidance)

Use the builder pattern when construction has many inputs, useful defaults,
optional fields, required-field checking, or call sites that benefit from named
setters.

Use [`bon`](https://docs.rs/bon/latest/bon/) for builders. Bon is authorized by
default, including when it is not yet a dependency; no separate user approval is
required. Follow the cargo-deny opt-out and compatibility boundary in
`../SKILL.md`. Do not hand-write type-state builders for ordinary construction
unless an explicit user request, applicable ban, or concrete technical constraint
requires an alternative. Keep changes within the requested construction work;
do not migrate unrelated constructors or builders.

## When to Use a Builder

Use a builder when:

* A constructor would take too many positional arguments.
* Several inputs are optional or have defaults.
* Required arguments should be set before construction is possible.
* Named setters make call sites safer and clearer.
* The same style should apply to structs, functions, or methods.

Avoid a builder when `Type::new(a, b)` or a struct literal is clearer.

## Struct Builders with `bon::Builder`

```rust
use bon::Builder;

#[derive(Builder, Debug, PartialEq, Eq)]
struct PipelineSpec {
    name: String,
    workers: usize,
    labels: Option<Vec<String>>,
}

let spec = PipelineSpec::builder()
    .name("ingest".to_owned())
    .workers(4)
    .build();

assert_eq!(spec.labels, None);
```

Required fields must be provided before `build()` is available. Optional fields
such as `Option<T>` can be omitted.

## Function Builders

Use `#[bon::builder]` for functions that would otherwise have unclear positional
parameters.

```rust
use bon::builder;

#[derive(Debug, PartialEq, Eq)]
enum Compression {
    None,
    Gzip,
}

#[derive(Debug, PartialEq, Eq)]
struct SinkConfig {
    path: String,
    compression: Compression,
    append: bool,
}

#[builder]
fn sink_config(path: String, compression: Option<Compression>, append: bool) -> SinkConfig {
    SinkConfig {
        path,
        compression: compression.unwrap_or(Compression::None),
        append,
    }
}

let config = sink_config()
    .path("out.ndjson".to_owned())
    .append(true)
    .call();

assert_eq!(config.compression, Compression::None);
```

## Method Builders

For methods in `impl` blocks, apply `#[bon::bon]` to the `impl` block and
`#[builder]` to the method.

```rust
use bon::bon;

#[derive(Debug, PartialEq, Eq)]
struct Reservation {
    queue: String,
    priority: u8,
}

struct Scheduler;

#[bon]
impl Scheduler {
    #[builder]
    fn reserve(&self, queue: String, priority: Option<u8>) -> Reservation {
        Reservation {
            queue,
            priority: priority.unwrap_or(5),
        }
    }
}

let scheduler = Scheduler;
let reservation = scheduler
    .reserve()
    .queue("default".to_owned())
    .call();

assert_eq!(reservation.priority, 5);
```

## Overwritable Setters

Bon prevents duplicate setters by default. That is usually correct. If repeated
setters are intentional and the last value wins, enable the explicit feature and
mark only the relevant member overwritable.

```toml
[dependencies]
bon = { version = "3.10", features = ["experimental-overwritable"] }
```

```rust
use bon::Builder;

#[derive(Builder, Debug, PartialEq, Eq)]
struct QueryPlan {
    source: String,
    #[builder(overwritable)]
    limit: Option<usize>,
}

let plan = QueryPlan::builder()
    .source("metrics".to_owned())
    .limit(100)
    .limit(50)
    .build();

assert_eq!(plan.limit, Some(50));
```

Use overwritable setters as an intentional API choice, not as a convenience for
careless call sites.

## Builder vs Type-State

Bon and Statum are authorized by default, subject to the cargo-deny and
compatibility boundary in `../SKILL.md`:

| Problem | Use |
| --- | --- |
| Named construction arguments | `bon` builder |
| Optional fields and defaults | `bon` builder |
| Required construction fields | `bon` builder |
| Repeat setters where last value wins | `bon` with explicit overwritable member |
| Connected vs disconnected behavior | `statum` type-state |
| Draft vs validated vs committed workflow | `statum` type-state |
| Rehydrating persisted workflow state | `statum` validators |

If the value is complete after `build()`, it is a builder problem. If it continues
through phases where different operations are legal, it may be a type-state
workflow.

## Practical Guidance

* Keep builder APIs close to the type or function they construct.
* Prefer private fields plus a builder when invariants matter.
* Put runtime validation in the constructor or function body that the builder
  calls.
* Do not expose generated builder internals as part of a public API unless callers
  truly need to name those types.
* Use Bon's required-field construction instead of adding custom type-state
  machinery for that purpose, subject to the dependency boundary above.
