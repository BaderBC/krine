# Clippy and Linting Discipline

## Contents

- [Default commands](#default-commands)
- [Cargo warning policy](#cargo-198-warning-policy)
- [CI quality jobs](#ci-quality-jobs)
- [Workspace profiles and lints](#workspace-profiles)
- [Fixing and suppressing warnings](#fix-warnings-before-suppressing-them)
- [Design feedback and MSRV](#lints-worth-treating-as-design-feedback)

Clippy is part of the Rust toolchain. Do not hard-code a Clippy version in docs or
scripts; ask the toolchain what is installed.

```sh
rustc -Vv
cargo clippy -V
rustup component add clippy
```

## Default Commands

Use a strict command for local review and CI:

```sh
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
cargo doc --workspace --all-features --no-deps --locked
```

Use `--all-features` when features are additive and compatible. If features are
mutually exclusive, test the documented feature matrix instead of pretending all
features can be enabled together.

## Cargo 1.98 Warning Policy

When a repository intentionally requires every ordinary Cargo build, check, or
test of local packages to reject lint warnings, use Cargo's `build.warnings`
configuration instead of a global `RUSTFLAGS=-Dwarnings` override:

```toml
[build]
warnings = "deny"
```

Use this when Rust 1.98 is the effective toolchain baseline and the repository has
adopted warning-free builds as policy. Keep an explicit
`cargo clippy ... -- -D warnings` command for Clippy-specific review. When a
separate lower-MSRV lane exists, validate its behavior independently instead of
assuming it interprets the active Cargo configuration identically.

## CI Quality Jobs

Prefer explicit CI jobs for documentation and package validation instead of
burying those checks inside a broad test script:

```sh
cargo doc --workspace --all-features --no-deps --locked
cargo publish --workspace --dry-run --locked
```

For virtual workspaces with release-order tooling, use the repository's release
plan or package dry-run command instead of forcing a plain workspace publish. For
intentionally unpublished workspaces, use the narrow package assembly check that
matches the repository's packaging contract.

Do not add Linux mold linker setup as a default CI or `.cargo/config.toml`
requirement. Keep linker overrides opt-in and repository-evidenced; CI should
prefer the stock runner toolchain unless the repository documents a real linker
requirement.

## Workspace Profiles

Profile tuning is workload-specific, not an idiomatic-Rust requirement. Preserve
the repository's profiles unless tuning is in scope. For a runtime-heavy
workspace targeting Rust 1.98, this is one candidate to measure against Cargo's
defaults, not a universal build-speed or runtime improvement:

```toml
[profile.dev]
codegen-units = 16
debug = "limited"
opt-level = 1
split-debuginfo = "unpacked"

[profile.dev.package."*"]
opt-level = 3

[profile.release]
codegen-units = 1
lto = "thin"
opt-level = 3
```

Use `debug = "limited"` instead of full debug info when stack traces and module
context are enough. Optimize non-workspace dependencies in dev profiles for UI,
graphics, parser, and async-heavy projects where dependency hot paths dominate
runtime behavior.

ThinLTO and fewer codegen units can improve optimized output at the cost of build
time; measure the trade-off instead of promising a universal speedup. Verify
`split-debuginfo` support on the repository's targets. Add `panic = "abort"` or
`strip = true` only for deliverable binaries that intentionally trade panic
unwinding or symbols for size.

## Workspace Lints

Prefer central lint policy in the workspace root, with crates opting in through
`[lints] workspace = true`.

```toml
[workspace.lints.rust]
c_void_returns = "warn"
future_incompatible = "deny"
invalid_runtime_symbol_definitions = "deny"
nonstandard_style = "deny"
suspicious_runtime_symbol_definitions = "warn"
unexpected_cfgs = { level = "deny", check-cfg = ["cfg(coverage)"] }
unsafe_op_in_unsafe_fn = "deny"
unused_must_use = "deny"

[workspace.lints.rustdoc]
bare_urls = "deny"
broken_intra_doc_links = "deny"

[workspace.lints.clippy]
all = { level = "warn", priority = -1 }
dbg_macro = "deny"
derive_partial_eq_without_eq = "warn"
err_expect = "warn"
incompatible_msrv = "deny"
iter_on_single_items = "warn"
needless_bool = "warn"
redundant_clone = "warn"
todo = "deny"
type_complexity = "allow"
uninlined_format_args = "allow"
unused_trait_names = "warn"
useless_conversion = "warn"
```

In member crates:

```toml
[lints]
workspace = true
```

Consider `clippy::pedantic` and `clippy::nursery` as review aids, not automatic
policy for every repository. Avoid `clippy::restriction` as a group; enable only
specific restriction lints that match team policy.

On the Rust 1.98 toolchain, `clippy::all` includes the new complexity, style,
and suspicious lints `unnecessary_unwrap_unchecked`,
`chunks_exact_to_as_chunks`, `by_ref_peekable_peek`,
`manual_isolate_lowest_one`, and `for_unbounded_range`. The new
`with_capacity_zero` and `unused_async_trait_impl` lints are `pedantic`, so enable
them individually or through an intentional `clippy::pedantic` review policy.
`empty_enums` is now in `nursery`, and `from_iter_instead_of_collect` is
deprecated; remove stale configuration rather than pinning a deprecated lint
name.

Keep the compiler's `invalid_runtime_symbol_definitions`,
`suspicious_runtime_symbol_definitions`, and `c_void_returns` diagnostics active.
A runtime shim or FFI adapter may use a narrow `#[expect(..., reason = "...")]`,
but a crate-wide allowance can hide an ABI error. Also expect `unsafe_code` to be
reported consistently on unsafe attributes; lint policy should account for both
unsafe blocks and unsafe attributes.

## Fix Warnings Before Suppressing Them

A lint suppression is a local design decision. Prefer `#[expect]` with a reason so
future Clippy runs warn when the expectation becomes stale.

```rust
#[expect(
    clippy::large_enum_variant,
    reason = "wire frames are matched in a hot loop and profiling favors locality"
)]
enum WireFrame {
    Ping,
    Payload([u8; 2048]),
}
```

When the warning is correct, fix the code instead:

```rust
enum WireFrame {
    Ping,
    Payload(Box<[u8; 2048]>),
}
```

Do not use crate-wide `#![allow(...)]` unless the crate has a documented policy
reason. Local `#[expect]` is usually easier to audit.

## Lints Worth Treating as Design Feedback

| Lint | Design signal |
| --- | --- |
| `redundant_clone` | Ownership can likely be simplified. |
| `clone_on_copy` | A small value is being cloned needlessly. |
| `needless_borrow` | Borrowing is obscuring type flow. |
| `manual_ok_or` | `Option`/`Result` conversion can be expressed directly. |
| `needless_collect` | An intermediate allocation may be avoidable. |
| `large_enum_variant` | Enum layout may waste stack or cache space. |
| `unnecessary_wraps` | The function's return type may overstate fallibility. |
| `missing_errors_doc` | A public fallible API needs better caller guidance. |
| `derive_partial_eq_without_eq` | A type may be able to advertise `Eq`. |
| `err_expect` | `expect_err` communicates intent more directly. |
| `incompatible_msrv` | Code may exceed the crate's declared `rust-version`. |
| `iter_on_single_items` | Iterator construction may hide a simpler expression. |
| `needless_bool` | Boolean control flow can be simplified. |
| `unused_trait_names` | Imports can likely be narrowed or made explicit. |
| `useless_conversion` | Conversion calls may be obscuring the actual type. |

Treat lints as prompts for design review, not as mechanical chores.

## Compatibility and MSRV

Clippy evolves with the compiler. When a repository has an MSRV lower than the
active toolchain, pin CI to the MSRV plus stable, or document that lint policy is
checked on stable only.

For libraries, avoid "fixing" a lint by raising MSRV unless the release notes and
crate policy justify that MSRV bump.
