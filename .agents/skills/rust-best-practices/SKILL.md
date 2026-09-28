---
name: rust-best-practices
description: >
  Guide for writing, refactoring, reviewing, optimizing, and documenting
  idiomatic Rust code on a Rust 1.98 stable baseline, with Bon and Statum
  authorized by default unless repository cargo-deny policy bans them. Keep
  other dependency adoption explicit and all changes task-scoped.
---

# Rust Best Practices

Use this skill when the user asks for Rust code, Rust refactors, code review,
performance review, error handling, documentation, API design, or lifecycle
modeling.

Assume **Rust 1.98 stable** and **edition 2024** unless the repository explicitly
declares a lower MSRV or the user gives a different target. Respect existing
`rust-toolchain.toml`, CI, `Cargo.toml`, workspace lints, target support, and
public API stability before introducing an API that exceeds the declared MSRV.

## Idiomatic Rust Requirement

All Rust implementations, API recommendations, generated code, and examples
produced or revised with this skill must be idiomatic for the repository's
edition, MSRV, and domain. Clearly label intentional counterexamples.

* Use conventional Rust names and standard traits such as `From`, `TryFrom`,
  `AsRef`, `IntoIterator`, `Display`, and `Error` when their contracts fit. Derive
  common traits when their semantics are correct; avoid redundant custom APIs.
* Make ownership explicit with borrowing, moves, and RAII. Do not introduce
  unnecessary clones, reference counting, shared mutability, or `unsafe` merely
  to work around the borrow checker.
* Choose the clearest `match`, `let-else`, `?`, iterator chain, or loop. Keep
  generic bounds minimal and abstractions proportional to the actual problem.
* Model absence and recoverable failure with `Option` and `Result`, preserving
  useful error sources and context. Reserve panics for explicit contracts or
  justified invariants rather than ordinary external-input failures.
* Prefer suitable standard-library APIs and established crate conventions. A
  newer feature, shorter expression, or additional dependency is not inherently
  more idiomatic.

Use the [Rust API Guidelines checklist](https://rust-lang.github.io/api-guidelines/checklist.html)
as a review aid, not permission to expand scope or override repository policy.
Review prose and examples together; passing compilation, rustfmt, or Clippy alone
is not proof that a design is idiomatic.

Named-library preferences and profile/lint presets are this skill's house style,
not a claim that alternatives are inherently non-idiomatic. Apply the dependency
boundary below without confusing authorization with a need for an abstraction.

## Repository and Dependency Adoption Boundary

Bon (`bon`) and Statum (`statum`) are authorized by default in both new and
existing repositories. Use Bon for suitable builder work and Statum for real
lifecycle or protocol type-state work. Add the appropriate dependency when it is
needed for the requested implementation or refactor; do not ask the user to
approve these dependencies separately. Their absence from `Cargo.toml`, an
existing manual implementation, or a dependency-free crate is not an opt-out.

Inspect the applicable cargo-deny configuration for an explicit opt-out, including
crate- and version-specific bans on `bon` or `statum`. It is commonly `deny.toml`,
`.deny.toml`, or `.cargo/deny.toml`; follow the configuration selected by repository
tooling when it uses a different path. With no matching ban, proceed without a
dependency-approval prompt. A missing cargo-deny configuration is not a blocker
and does not require introducing cargo-deny. If a ban applies, identify its file
and rule and use a permitted alternative. Do not remove or weaken the rule to
force adoption. Honor an explicit user request to avoid a dependency or use a
manual pattern.

Default authorization does not waive MSRV, feature, `no_std`, target, public API,
license, source, or security constraints, including restrictions affecting
transitive dependencies. Select compatible versions and follow the repository's
manifest and lockfile conventions. Report a concrete incompatibility rather than
inventing an approval requirement. Keep adoption within the requested change;
do not migrate unrelated constructors, state machines, or APIs.

Prefer declaring shared direct dependencies in the workspace root's
`[workspace.dependencies]` table. Inherit them in member manifests with the
explicit `{ workspace = true }` inline-table form when the members can share the
same version, source, and baseline feature policy. Prefer this form to dotted
`dependency.workspace = true` syntax so member-specific settings such as
`features` can be added to the same declaration. Keep a declaration member-local,
or use explicitly renamed workspace dependencies, when members genuinely
require different direct versions, sources, or feature defaults. A transitive
disagreement, such as two dependencies requiring semver-incompatible versions
of a third crate, is not by itself a reason to keep the direct dependencies
local: Cargo resolves transitive versions independently and may build multiple
semver-incompatible versions.
Account for resolver failures and crates whose native `links` declarations
prevent multiple versions from coexisting.

For other libraries, including Strum, template engines, and error-handling
libraries, preserve established dependencies, versions, patterns, and dependency
policy unless adoption or migration is part of the requested scope. Apply their
house-style preferences when already adopted or explicitly authorized; otherwise
use the established implementation and label alternatives as recommendations.
The Bon and Statum default authorization takes precedence over generic
adoption-or-authorization language in the references.

Reviews are read-only unless the user asks to apply changes. Separate correctness
findings from house-style suggestions; a manual implementation is not a defect
solely because a preferred library could generate it.

## Rust 1.98 Baseline Guidance

* Prefer stable Rust. Do not suggest nightly-only features unless the repository
  already uses nightly and the reason is explicit.
* Use `let PATTERN = expr else { ... };` for early exits where the fallback does
  not need the failed value.
* Use `?` for straightforward error propagation, `map_err` for typed translation,
  and `inspect_err` for local observability.
* Use `str::substr_range` and `[T]::subslice_range` to recover source offsets from
  subslices already derived from the same source. These APIs use provenance and
  pointer arithmetic; they do not search by value.
* Use `strip_circumfix` when a prefix and suffix must both be present and
  non-overlapping. Prefer it to chained stripping that can accidentally accept a
  one-sided match.
* Use `core::range::{Range, RangeInclusive, RangeFrom}` when a concrete stored
  range benefits from being `Copy`. For public APIs, usually accept
  `impl core::ops::RangeBounds<usize>` unless the concrete type is part of the
  domain model.
* Prefer direct typed operations: integer bit-inspection methods for bit-domain
  logic, `NonZero*::from_str_radix` for non-zero radix parsing, and
  `String::from_utf16le`/`from_utf16be` when byte order is part of the input
  format.
* Use `core::fmt::NumBuffer` with integer `format_into` only in measured,
  allocation-sensitive paths where the caller can reuse the buffer. Use normal
  formatting for ordinary code.
* Use floating-point `algebraic_*` operations only when profiling shows a benefit
  and the API contract tolerates reassociation, unspecified precision, and
  non-deterministic behavior for NaN, infinity, and signed zero.
* Prefer primitive `char` associated items such as `char::from_u32` and
  `char::REPLACEMENT_CHARACTER`.
* Prefer borrowing (`&str`, `&[T]`, `&T`) for read-only APIs. Take ownership only
  when the function stores, transforms, or consumes the value.
* Prefer `impl Trait` for single-use input polymorphism. Use named generics when
  multiple parameters or a return value must share the same type.
* Prefer static dispatch unless heterogeneity, deliberate type erasure, or
  measured compile-time/code-size trade-offs justify `dyn Trait`. Rust trait
  objects do not provide a stable FFI or dynamic-library ABI.
* Keep runtime-symbol and FFI definitions lint-clean. Do not globally suppress
  `invalid_runtime_symbol_definitions`, `suspicious_runtime_symbol_definitions`,
  or `c_void_returns`; use a narrow, documented exception only at a real runtime
  or foreign-function boundary.
* Use `bon` for builders instead of hand-rolling type-state builders for ordinary
  construction. Bon is authorized by default under the cargo-deny boundary above.
* Use `statum` for real lifecycle or protocol type-state. Statum is authorized by
  default under the same boundary; do not use type-state as a generic replacement
  for builders or enums.
* Keep examples generic, self-contained, and domain-neutral unless the user gives
  domain vocabulary.

## References

Read only the chapters relevant to the task. For broad reviews or refactors, read
several relevant chapters together before giving feedback.

* [Coding Styles and Idioms](references/coding-styles-and-idioms.md)
* [Code Generation Templates](references/code-generation-templates.md)
* [Enum String Conversions](references/enum-string-conversions.md)
* [Clippy and Linting Discipline](references/clippy-and-linting-discipline.md)
* [Performance Mindset](references/performance-mindset.md)
* [Error Handling](references/error-handling.md)
* [Generics, Static Dispatch, and Dynamic Dispatch](references/generics-static-and-dynamic-dispatch.md)
* [Builder Pattern](references/builder-pattern.md)
* [Type State Pattern](references/type-state-pattern.md)
* [Comments vs Documentation](references/comments-vs-documentation.md)
* [Pointer Types and Thread Safety](references/pointer-types-and-thread-safety.md)
