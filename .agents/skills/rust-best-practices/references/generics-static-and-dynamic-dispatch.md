# Generics, Static Dispatch, and Dynamic Dispatch

## Contents

* [Generics](#generics)
* [`impl Trait` inputs and returns](#impl-trait-for-input-ergonomics)
* [Static dispatch](#static-dispatch)
* [Dynamic dispatch](#dynamic-dispatch-with-dyn-trait)
* [Dyn compatibility](#dyn-compatibility-checklist)
* [Trade-offs](#trade-off-summary)

> Choose dispatch to fit type relationships, heterogeneity, and measured costs.

Rust supports polymorphism through generics, `impl Trait`, and trait objects. The
right choice depends on whether the concrete type is known at compile time, needs
to relate to other types, or must be erased at runtime.

## Generics

Use named generics when relationships matter: two arguments must have the same
concrete type, a return type depends on an input type, or bounds are easier to
read in a `where` clause.

```rust
trait Encode {
    fn encode(&self, out: &mut Vec<u8>);
}

fn encode_all<I>(items: I) -> Vec<u8>
where
    I: IntoIterator,
    I::Item: Encode,
{
    let mut out = Vec::new();
    for item in items {
        item.encode(&mut out);
    }
    out
}
```

A `where` clause separates trait constraints from the function signature. This
example concatenates cloned values in input order; it does not sort or merge them.

```rust
fn concat_cloned<T>(left: &[T], right: &[T]) -> Vec<T>
where
    T: Clone,
{
    left.iter().chain(right).cloned().collect()
}
# assert_eq!(concat_cloned(&[1, 3], &[2, 4]), vec![1, 3, 2, 4]);
```

## `impl Trait` for Input Ergonomics

Use argument-position `impl Trait` when the concrete type does not need a name.

```rust
fn emit_line(mut write: impl std::io::Write, line: &str) -> std::io::Result<()> {
    writeln!(write, "{line}")
}
```

Do not use `impl Trait` when two arguments must be the same concrete type. Use a
named generic instead. Moving the owned inputs does not require `Clone`.

```rust
fn same_codec<C>(left: C, right: C) -> (C, C) {
    (left, right)
}

struct Codec(u8);

let (left, right) = same_codec(Codec(1), Codec(2));
assert_eq!(left.0, 1);
assert_eq!(right.0, 2);
```

## Return-Position `impl Trait`

Return `impl Trait` to hide a concrete iterator or future while preserving static
dispatch.

```rust
fn non_empty_segments(input: &str) -> impl Iterator<Item = &str> {
    input.split('/').filter(|segment| !segment.is_empty())
}

let segments: Vec<_> = non_empty_segments("/alpha//beta/").collect();
assert_eq!(segments, ["alpha", "beta"]);
```

A public function can return `impl Trait` backed by a private concrete type;
that hiding is intentional. Exposed trait bounds, auto-traits, and captured
lifetimes still affect callers. In public traits, methods returning `impl Trait`
or using `async fn` are not dynamically dispatchable; add `where Self: Sized`
when excluding those methods from trait objects fits the API.

## Static Dispatch

Generic and `impl Trait` code is statically dispatched and monomorphized. This
usually enables inlining and removes runtime dispatch, but it may increase compile
time and binary size.

```rust
trait Weight {
    fn weight(&self) -> u64;
}

fn total_weight<T>(items: &[T]) -> u64
where
    T: Weight,
{
    items.iter().map(Weight::weight).sum()
}
```

Prefer static dispatch for hot paths, library helpers where callers know the
concrete type, and code that does not need runtime heterogeneity.

## Dynamic Dispatch with `dyn Trait`

Use trait objects for heterogeneous values behind one interface or deliberate
type erasure. They can also reduce monomorphization when compile time or code
size is a measured concern. Rust trait objects do not provide a stable FFI or
dynamic-library ABI; those boundaries need an explicit compatible representation.

```rust
struct Batch {
    lines: Vec<String>,
}

trait Stage {
    fn run(&self, batch: &mut Batch);
}

struct TrimStage;
impl Stage for TrimStage {
    fn run(&self, batch: &mut Batch) {
        for line in &mut batch.lines {
            *line = line.trim().to_owned();
        }
    }
}

struct LowercaseStage;
impl Stage for LowercaseStage {
    fn run(&self, batch: &mut Batch) {
        for line in &mut batch.lines {
            line.make_ascii_lowercase();
        }
    }
}

fn run_pipeline(stages: &[&dyn Stage], batch: &mut Batch) {
    for stage in stages {
        stage.run(batch);
    }
}

let mut batch = Batch {
    lines: vec![" Alpha ".to_owned(), "BETA ".to_owned()],
};
run_pipeline(&[&TrimStage, &LowercaseStage], &mut batch);
assert_eq!(batch.lines, ["alpha", "beta"]);
```

Prefer `&dyn Trait` when you do not need ownership, `Box<dyn Trait>` for owned
heterogeneous values, and `Arc<dyn Trait + Send + Sync>` for shared objects across
threads. Borrowing the stages above lets callers choose their storage instead of
requiring a box for every stage.

## Dyn Compatibility Checklist

A trait must be [dyn-compatible](https://doc.rust-lang.org/reference/items/traits.html#dyn-compatibility)
before it can be used as `dyn Trait`:

* The trait must not require `Self: Sized`, and its supertraits must also be
  dyn-compatible.
* Associated constants prevent dyn compatibility. Generic associated types must
  opt out of the dyn interface with `where Self: Sized`. Ordinary associated
  types are permitted and must be specified where required.
* Dispatchable methods use supported receivers such as `&self`, `&mut self`,
  `Box<Self>`, `Rc<Self>`, `Arc<Self>`, or supported pinned forms. An ordinary
  by-value `self` method cannot be called through a trait object.
* Dispatchable methods have no type or const parameters and no opaque return
  type (`impl Trait` or `async fn`). Lifetime parameters and specified associated
  types such as `Self::Item` are allowed. The implementing `Self` type cannot be
  another argument or return value, including inside a container.
* Constructors, generic methods, and methods returning `Self` or opaque types
  can remain on the trait with `where Self: Sized`, excluding those methods from
  dynamic dispatch without excluding the whole trait.

`Runnable` supports dynamic dispatch:

```rust
trait Runnable {
    fn run(&self);
}

fn run(task: &dyn Runnable) {
    task.run();
}
```

`Factory` does not: `create` is generic, has no receiver, and is not excluded with
`where Self: Sized`:

```rust,compile_fail
trait Factory {
    fn create<T>() -> T;
}

fn accept_factory(_: &dyn Factory) {}
```

## Trade-Off Summary

| Choice | Strength | Cost |
| --- | --- | --- |
| Named generics | Express type relationships clearly | More syntax |
| `impl Trait` arguments | Concise static dispatch | Cannot name or relate hidden type |
| Return `impl Trait` | Hides concrete iterator/future | Hidden type still affects public API |
| `dyn Trait` | Runtime heterogeneity and type erasure | Vtable dispatch, dyn-compatibility limits |

Start static when it fits the API. Introduce dynamic dispatch when type erasure
or measured compile-time/code-size trade-offs are part of the design.
