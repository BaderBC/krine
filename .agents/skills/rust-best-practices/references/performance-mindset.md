# Performance Mindset

## Contents

* [First checks](#first-checks)
* [Allocation and cloning](#avoid-redundant-allocation)
* [Dispatch and layout](#static-dispatch-first)
* [Inlining](#profile-before-inline)
* [Buffered integer formatting](#reuse-a-numbuffer-in-allocation-sensitive-code)
* [Algebraic floating-point operations](#use-algebraic-floating-point-operations-only-with-an-explicit-contract)
* [Rust 1.98 tooling compatibility](#tooling-compatibility-on-rust-198)

The first rule of Rust performance work is still: **do not guess, measure**.

Rust is often fast without manual tuning. Optimize after identifying a bottleneck,
and keep the before/after evidence in the PR description or benchmark output.

## First Checks

* Build with `--release` before comparing Rust with another language.
* Use `cargo test --release` for tests that are performance-sensitive.
* Use `cargo bench`, Criterion, `hyperfine`, `cargo flamegraph`, `samply`, or
  platform profilers to find actual bottlenecks.
* Run Clippy's performance lints with the repository's ordinary lint command.

```sh
cargo build --release --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo bench --locked
```

## Avoid Redundant Allocation

Do not collect just to iterate once more.

```rust
fn total_encoded_len<'a>(parts: impl IntoIterator<Item = &'a str>) -> usize {
    parts.into_iter().map(str::len).sum()
}

let total = total_encoded_len(["aa", "bbb", "c"]);
assert_eq!(total, 6);
```

If the caller needs a collection, return a collection. If the callee only needs to
consume items, accept an iterator.

```rust
fn write_records<'a>(records: impl IntoIterator<Item = &'a str>, out: &mut String) {
    for record in records {
        out.push_str(record);
        out.push('\n');
    }
}
```

## Allocate with Intent

Use capacity hints when the size is known or cheaply estimated.

```rust
fn join_codes(codes: &[&str]) -> String {
    let estimated = codes.iter().map(|code| code.len() + 1).sum();
    let mut output = String::with_capacity(estimated);

    for code in codes {
        output.push_str(code);
        output.push(';');
    }

    output
}
```

For large buffers, prefer heap allocation through `Vec`/`Box<[T]>` instead of
placing large arrays on the stack.

```rust
let buffer: Box<[u8]> = vec![0; 64 * 1024].into_boxed_slice();
assert_eq!(buffer.len(), 65_536);
```

## Clone Late or Not at All

Clone handles intentionally; avoid cloning payloads accidentally.

```rust
use std::sync::Arc;

#[derive(Debug)]
struct LookupTable(Vec<u32>);

fn fan_out(table: &Arc<LookupTable>, workers: usize) -> Vec<Arc<LookupTable>> {
    (0..workers).map(|_| Arc::clone(table)).collect()
}

let table = Arc::new(LookupTable(vec![1, 2, 3]));
let handles = fan_out(&table, 2);
assert_eq!(handles.len(), 2);
assert!(handles.iter().all(|handle| Arc::ptr_eq(handle, &table)));
assert!(fan_out(&table, 0).is_empty());
```

`Arc::clone` communicates "new owner of the same allocation" better than
`table.clone()` in shared ownership code.

## Static Dispatch First

Generic functions are monomorphized, which allows inlining and optimization at the
cost of compile time and possible binary growth.

```rust
trait Score {
    fn score(&self) -> u64;
}

fn best_score<T>(items: &[T]) -> Option<u64>
where
    T: Score,
{
    items.iter().map(Score::score).max()
}
```

Use `dyn Trait` for runtime heterogeneity or deliberate type erasure, including
measured compile-time or code-size improvements. Compare the relevant costs
rather than treating either dispatch choice as universally faster.

## Use Layout-Aware Types

Avoid huge enum variants. Box large variants when they make every value of the
enum unnecessarily large.

```rust
enum DecodeStep {
    Pending,
    Complete(Box<[u8; 4096]>),
}
```

Keep recursive structures behind indirection.

```rust
enum TreeNode<T> {
    Leaf(T),
    Branch(Box<TreeNode<T>>, Box<TreeNode<T>>),
}
```

## Profile Before `#[inline]`

The compiler already inlines aggressively where profitable. Add `#[inline]`,
`#[inline(always)]`, or `#[cold]` only when profiling or generated-code review
supports the decision.

```rust
#[cold]
fn invalid_checksum_observed(expected: u32, actual: u32) -> String {
    format!("checksum mismatch: expected {expected}, got {actual}")
}
```

## Reuse a `NumBuffer` in Allocation-Sensitive Code

For decimal integer formatting in a measured hot path, let the caller reuse a
`core::fmt::NumBuffer` and consume the returned `&str` before formatting the next
value into that buffer.

```rust
use core::fmt::NumBuffer;

fn write_ids(ids: impl IntoIterator<Item = u64>, output: &mut String) {
    let mut buffer = NumBuffer::new();

    for id in ids {
        output.push_str(id.format_into(&mut buffer));
        output.push('\n');
    }
}

let mut output = String::new();
write_ids([7, 42, 9001], &mut output);
assert_eq!(output, "7\n42\n9001\n");
```

Use ordinary `format!`, `write!`, or `Display` implementations outside such
paths. `NumBuffer` is a specialized optimization, not a replacement for the
formatting ecosystem, and the borrowed text is overwritten by the next mutable
use of the buffer.

## Use Algebraic Floating-Point Operations Only with an Explicit Contract

The `algebraic_add`, `algebraic_sub`, `algebraic_mul`, `algebraic_div`, and
`algebraic_rem` methods permit optimizations that ordinary IEEE-style source
operations do not, including reassociation and reciprocal transformations. They
can unlock vectorization, but their precision and treatment of NaN, infinity, and
signed zero are intentionally less constrained.

```rust
fn relaxed_dot(lhs: &[f32], rhs: &[f32]) -> f32 {
    lhs.iter()
        .zip(rhs)
        .fold(0.0_f32, |sum, (&left, &right)| {
            sum.algebraic_add(left.algebraic_mul(right))
        })
}
```

Use them only when all of the following are true: profiling shows the ordinary
operations are a bottleneck; the public contract accepts platform- and
optimization-dependent results; tests use error bounds or invariants rather than
exact bit patterns; and no unsafe-code soundness argument depends on the result.
Do not use them for reproducible serialization, exact threshold decisions,
financial calculations, or code that assigns semantic meaning to NaN payloads or
signed zero.

## Tooling Compatibility on Rust 1.98

Rust 1.98 uses v0 symbol mangling by default. If a profiler, debugger, crash
reporter, or symbol post-processor cannot demangle Rust frames, update that tool
before restoring legacy mangling. Treat changed backtrace spelling as tooling
compatibility evidence rather than an application performance regression.

On WebAssembly targets, undefined linker symbols are not silently accepted. Treat
link failures as boundary feedback. Override that behavior only when the import
is intentional, documented, and validated by the target-specific build.
