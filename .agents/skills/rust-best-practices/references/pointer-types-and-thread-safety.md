# Pointer Types and Thread Safety

## Contents

* [Pointer selection](#pointer-selection-table)
* [Borrowing and boxes](#borrowing)
* [`Rc` and `Arc`](#rct-and-arct)
* [Interior mutability](#interior-mutability)
* [One-time initialization](#one-time-initialization)
* [Atomic views over exclusive storage](#atomic-views-over-exclusive-storage)
* [Process and environment iterators](#process-and-environment-iterators)
* [Raw pointers](#raw-pointers)

Rust encodes thread-safety through `Send` and `Sync`:

* `Send`: a value can be moved to another thread.
* `Sync`: shared references to the value can be used from multiple threads.

A pointer is thread-safe only when the data behind it satisfies the relevant
bounds.

## Pointer Selection Table

| Type | Ownership model | Thread-sharing guidance |
| --- | --- | --- |
| `&T` | Shared borrow | Thread-safe when `T: Sync`. |
| `&mut T` | Exclusive borrow | Movable when `T: Send`; still exclusive. |
| `Box<T>` | Single owner on heap | `Send`/`Sync` follows `T`. |
| `Rc<T>` | Non-atomic ref count | Single-thread only. |
| `Arc<T>` | Atomic ref count | Multi-thread shared ownership when `T: Send + Sync`. |
| `Cell<T>` | Interior mutability by moving or replacing values; `get()` requires `Copy` | Single-thread interior mutation; not `Sync`. |
| `RefCell<T>` | Runtime borrow checking | Single-thread shared mutation; not `Sync`; may panic. |
| `Mutex<T>` | Exclusive locked access | Multi-thread mutation when `T: Send`. |
| `RwLock<T>` | Shared reads or exclusive write | Multi-thread read-heavy mutation when `T: Send + Sync`. |
| `OnceCell<T>` | Single-thread one-time init | Use for local lazy initialization. |
| `LazyCell<T>` | Single-thread lazy init | Use when value construction can be delayed. |
| `OnceLock<T>` | Thread-safe one-time init | Use for global or shared initialization. |
| `LazyLock<T>` | Thread-safe lazy init | Use for global lazy initialization. |
| `*const T`, `*mut T` | Raw pointer | Neither `Send` nor `Sync` by default; dereferencing requires `unsafe` and upheld invariants. |

## Borrowing

Use `&T` for shared read access.

```rust
fn checksum(bytes: &[u8]) -> u8 {
    bytes.iter().copied().fold(0, u8::wrapping_add)
}

assert_eq!(checksum(&[1, 2, 3]), 6);
```

Use `&mut T` for exclusive mutation.

```rust
fn append_marker(buffer: &mut String, marker: &str) {
    buffer.push(':');
    buffer.push_str(marker);
}

let mut buffer = String::from("batch");
append_marker(&mut buffer, "ready");
assert_eq!(buffer, "batch:ready");
```

## `Box<T>`

Use `Box<T>` for owning heap indirection, recursive data, trait-object ownership,
or reducing the size of a containing value. Moving a box does not move its
allocation, but heap allocation alone does not pin the value.

```rust
enum Expr {
    Value(i64),
    Add(Box<Expr>, Box<Expr>),
}
```

## `Rc<T>` and `Arc<T>`

Use `Rc<T>` for shared ownership within one thread. Use `Arc<T>` for shared
ownership across threads.

```rust
use std::sync::Arc;
use std::thread;

let table: Arc<[u16]> = Arc::from([10, 20, 30]);
let worker_table = Arc::clone(&table);

thread::spawn(move || assert_eq!(worker_table[1], 20))
    .join()
    .unwrap();
```

Use `Arc::clone(&value)` rather than `value.clone()` when you want to emphasize
shared ownership.

## Interior Mutability

Use `Cell<T>` when mutation can move or replace values without borrowing their
contents. `get()` requires `T: Copy`, but `set`, `replace`, and `into_inner` also
work with non-`Copy` values; `take()` requires `T: Default`. See the
[`Cell` API](https://doc.rust-lang.org/std/cell/struct.Cell.html) for each method's
bounds. Small `Copy` values are a common use:

```rust
use std::cell::Cell;

let retries = Cell::new(0u8);
retries.set(retries.get() + 1);
assert_eq!(retries.get(), 1);
```

Non-`Copy` values can also be replaced without runtime borrow checking:

```rust
use std::cell::Cell;

let status = Cell::new(String::from("queued"));
let previous = status.replace(String::from("running"));
assert_eq!(previous, "queued");
assert_eq!(status.into_inner(), "running");
```

Use `RefCell<T>` only when compile-time borrowing cannot express the local design.
It enforces borrowing at runtime and can panic.

```rust
use std::cell::RefCell;

let notes = RefCell::new(Vec::new());
notes.borrow_mut().push("created");
assert_eq!(notes.borrow().len(), 1);
```

For multi-thread shared mutation, use `Mutex<T>` or `RwLock<T>`, usually behind
`Arc`.

```rust
use std::sync::{Arc, Mutex};

let counter = Arc::new(Mutex::new(0usize));
let worker_counter = Arc::clone(&counter);

std::thread::spawn(move || {
    *worker_counter.lock().expect("counter lock poisoned") += 1;
})
.join()
.unwrap();

assert_eq!(*counter.lock().unwrap(), 1);
```

## One-Time Initialization

Use `OnceLock` or `LazyLock` for thread-safe initialization.

```rust
use std::collections::HashMap;
use std::sync::LazyLock;

static STATUS_CODES: LazyLock<HashMap<&'static str, u16>> = LazyLock::new(|| {
    HashMap::from([("queued", 1), ("running", 2), ("done", 3)])
});

assert_eq!(STATUS_CODES.get("done"), Some(&3));
```

Use `std::cell::OnceCell` or `LazyCell` for single-threaded local structures.

## Atomic Views Over Exclusive Storage

Rust 1.98 can borrow primitive storage as atomic storage, or borrow an exclusively
owned atomic slice as its primitive representation. This avoids allocation and
unsafe pointer casts when a phase of an algorithm changes its access mode.

```rust
use std::sync::atomic::{AtomicU8, Ordering};

let mut bytes = [0_u8; 4];
let atomics = AtomicU8::from_mut_slice(&mut bytes);

std::thread::scope(|scope| {
    for (index, cell) in atomics.iter().enumerate() {
        scope.spawn(move || cell.store(index as u8, Ordering::Relaxed));
    }
});

assert_eq!(bytes, [0, 1, 2, 3]);
```

Use an ordering justified by the synchronization contract. `Relaxed` provides
atomic access without ordering other memory; the scoped-thread joins above
establish completion before the non-atomic read. The exclusive borrow prevents
safe non-atomic access while the atomic view exists. Do not weaken an ordering
without verifying how other memory is published and observed.
For integer and pointer atomics wider than a byte, these view methods are
available only on targets where the primitive and atomic alignments match. Use
the applicable `target_has_atomic` and
`target_has_atomic_primitive_alignment` cfgs, together with the repository's
target matrix, where portability matters.

`Atomic*::get_mut_slice` performs the reverse operation under an exclusive
borrow. It is appropriate for single-threaded initialization or teardown, not for
bypassing synchronization while other threads can observe the atomics.

## Process and Environment Iterators

`std::process::CommandArgs` can be sent or shared when its borrow remains valid,
but `std::env::Vars` and `VarsOs` are not cross-thread iterators. Collect owned
environment entries before moving them to another thread:

```rust
use std::ffi::OsString;

let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
let expected_count = environment.len();
let count = std::thread::spawn(move || environment.len())
    .join()
    .expect("environment worker panicked");

assert_eq!(count, expected_count);
```

Prefer collecting only the entries the worker needs rather than copying the
entire process environment by default.

## Raw Pointers

Raw pointers are for FFI, low-level data structures, and performance-sensitive
code where safe references cannot model the operation. Keep unsafe blocks small
and document the invariants.

Prefer safe APIs whenever they express the operation. A bounds-checked read needs
no raw pointer or `unsafe` block:

```rust
fn read_at(bytes: &[u8], index: usize) -> Option<u8> {
    bytes.get(index).copied()
}

assert_eq!(read_at(b"abc", 1), Some(b'b'));
assert_eq!(read_at(b"abc", 3), None);
assert_eq!(read_at(b"", 0), None);
assert_eq!(read_at(b"abc", usize::MAX), None);
```
