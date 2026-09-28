# Coding Styles and Idioms

## Contents

- [Borrowing and copying](#borrow-before-you-clone)
- [`Option` and `Result` control flow](#option-and-result-choose-the-clearest-control-flow)
- [Allocation and iteration](#avoid-early-allocation)
- [Range APIs](#range-apis)
- [Recovering derived ranges](#recover-ranges-from-derived-substrings-and-subslices)
- [Paired boundary stripping](#strip-paired-boundaries-atomically)
- [Typed parsing and explicit text encoding](#use-typed-parsing-and-explicit-text-encoding)
- [Integer bit inspection](#integer-bit-inspection)
- [`char` associated items](#prefer-char-associated-items)
- [Imports](#imports)

## Borrow Before You Clone

Rust's ownership model makes borrowing the default shape for read-only code. A
function that only observes data should usually accept `&T`, `&str`, or `&[T]`.

```rust
fn render_label(label: &str) -> String {
    format!("label:{label}")
}

let owned_label = String::from("batch-alpha");
let rendered = render_label(&owned_label);
assert_eq!(rendered, "label:batch-alpha");
```

Clone only when you actually need a second owned value. Common valid cases are
reference-counted handles (`Arc`, `Rc`), snapshots, background tasks that need
`'static` ownership, or APIs that intentionally store the value.

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
struct PacketTemplate {
    headers: Vec<String>,
}

fn checkpoint(template: &PacketTemplate) -> PacketTemplate {
    template.clone()
}
```

Avoid accidental clones inside loops. When a second owned copy of an entire
slice is needed, use `to_vec()` directly.

```rust
let labels = [String::from("fast"), String::from("safe")];
let copied = labels.to_vec();
assert_eq!(copied, labels);
```

## Pass Small `Copy` Values by Value

If a type is small and implements `Copy`, passing by value is often clearer and
at least as efficient as passing by reference.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GridPoint {
    row: u16,
    col: u16,
}

fn shift_right(point: GridPoint) -> GridPoint {
    GridPoint {
        col: point.col + 1,
        ..point
    }
}

let start = GridPoint { row: 4, col: 7 };
assert_eq!(shift_right(start), GridPoint { row: 4, col: 8 });
assert_eq!(start.col, 7);
```

Consider deriving `Copy` only when all fields are `Copy`, the value is small, and
copying it cannot hide ownership or resource semantics. Do not force `Copy` onto
large arrays, heap-owning data, locks, file handles, sockets, or domain values
whose duplication should be explicit.

## `Option` and `Result`: Choose the Clearest Control Flow

Use `?` when the caller can handle the same error type or a `From` conversion is
available.

```rust
#[derive(Debug, thiserror::Error)]
enum HeaderError {
    #[error("missing separator")]
    MissingSeparator,
    #[error("invalid revision")]
    InvalidRevision(#[from] std::num::ParseIntError),
}

#[derive(Debug, PartialEq, Eq)]
struct Header {
    kind: String,
    revision: u16,
}

fn parse_header(input: &str) -> Result<Header, HeaderError> {
    let Some((kind, revision)) = input.split_once(':') else {
        return Err(HeaderError::MissingSeparator);
    };

    Ok(Header {
        kind: kind.to_owned(),
        revision: revision.parse()?,
    })
}
```

Use `let-else` when a missing value is an expected branch and the fallback can
return, break, continue, or otherwise diverge, as in `parse_header` above. For a
simple search, iterator adapters can express the intent without bookkeeping:

```rust
fn first_non_empty<'a>(lines: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    lines.into_iter().map(str::trim).find(|line| !line.is_empty())
}

assert_eq!(first_non_empty(["", "  ", " ready ", "later"]), Some("ready"));
assert_eq!(first_non_empty(["", "  "]), None);
assert_eq!(first_non_empty([]), None);
```

Use `match` when each variant carries meaningful behavior.

```rust
#[derive(Debug, PartialEq, Eq)]
enum Signal {
    Start,
    Data(Vec<u8>),
    Stop,
}

fn signal_cost(signal: &Signal) -> usize {
    match signal {
        Signal::Start => 1,
        Signal::Data(bytes) => bytes.len(),
        Signal::Stop => 0,
    }
}
```

Avoid `unwrap` and `expect` outside tests unless failure is impossible by a local
invariant and the message explains that invariant.

## Avoid Early Allocation

Prefer lazy alternatives when the fallback allocates, logs, performs I/O, or calls
a function with side effects.

```rust
#[derive(Debug, PartialEq, Eq)]
struct ParseNote(String);

fn label_or_default(label: Option<&str>) -> String {
    label
        .map(str::to_owned)
        .unwrap_or_else(|| "unnamed-batch".to_owned())
}

fn note_for_code(code: Result<u16, ParseNote>) -> String {
    code.map_or_else(
        |err| format!("invalid code: {}", err.0),
        |value| format!("code:{value}"),
    )
}
```

Use `ok_or_else`, `unwrap_or_else`, and `map_or_else` when constructing the
fallback is nontrivial. Use `unwrap_or_default` when the default is the obvious
empty/default value.

## Iterators and `for` Loops

Both iterator chains and `for` loops are idiomatic. Pick the one that preserves
intent.

Prefer iterator chains for transformations:

```rust
fn active_codes(records: &[(&str, bool)]) -> Vec<String> {
    records
        .iter()
        .filter(|(_, active)| *active)
        .map(|(code, _)| code.to_ascii_uppercase())
        .collect()
}

let records = [("ab", true), ("cd", false), ("ef", true)];
assert_eq!(active_codes(&records), ["AB", "EF"]);
```

Prefer `for` when early exit, mutation, or side effects are central:

```rust
fn stop_at_marker(values: &mut [u16], marker: u16) {
    for value in values {
        if *value == marker {
            break;
        }
        *value += 1;
    }
}
```

Do not allocate intermediate collections just to iterate again. Accept iterators
when the consumer does not require random access.

```rust
fn checksum(bytes: impl IntoIterator<Item = u8>) -> u8 {
    bytes.into_iter().fold(0, u8::wrapping_add)
}

let checksum = checksum([1, 2, 3].into_iter().map(|byte| byte * 2));
assert_eq!(checksum, 12);
```

## Range APIs

Use the concrete range types under `core::range` when a range is stored in a
small `Copy` value. For public APIs, prefer accepting `impl RangeBounds<usize>`
so callers can pass ordinary range syntax or a concrete stored range.

```rust
use core::range::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ByteSpan {
    range: Range<usize>,
}

impl ByteSpan {
    fn read_from(self, bytes: &[u8]) -> &[u8] {
        &bytes[self.range]
    }
}

let span = ByteSpan {
    range: Range { start: 1, end: 4 },
};
assert_eq!(span.read_from(b"frames"), b"ram");
```

For generic public range inputs, normalize bounds once and use checked arithmetic
at the boundary:

```rust
use core::ops::{Bound, RangeBounds};

fn select_window(bytes: &[u8], range: impl RangeBounds<usize>) -> Option<&[u8]> {
    let start = match range.start_bound() {
        Bound::Included(&index) => index,
        Bound::Excluded(&index) => index.checked_add(1)?,
        Bound::Unbounded => 0,
    };
    let end = match range.end_bound() {
        Bound::Included(&index) => index.checked_add(1)?,
        Bound::Excluded(&index) => index,
        Bound::Unbounded => bytes.len(),
    };

    bytes.get(start..end)
}

assert_eq!(select_window(b"abcdef", 2..=4), Some(&b"cde"[..]));
assert_eq!(select_window(b"abcdef", ..), Some(&b"abcdef"[..]));
assert_eq!(select_window(b"abcdef", 7..), None);
assert_eq!(select_window(b"abcdef", ..=usize::MAX), None);
assert_eq!(
    select_window(b"abcdef", (Bound::Excluded(usize::MAX), Bound::Unbounded)),
    None,
);
```

## Recover Ranges from Derived Substrings and Subslices

Use `str::substr_range` and `[T]::subslice_range` when an iterator or parser has
already returned a borrow into a source and the caller needs its original range.
These methods do not search for equal contents; they identify where the borrowed
view came from.

```rust
use core::range::Range;

let source = "left|middle|right";
let middle = source.split('|').nth(1).expect("middle field");
assert_eq!(
    source.substr_range(middle),
    Some(Range { start: 5, end: 11 }),
);

let values = [10, 20, 30, 40];
let window = &values[1..3];
assert_eq!(
    values.subslice_range(window),
    Some(Range { start: 1, end: 3 }),
);
```

Do not use these APIs as a value search; use `find`, `position`, or `windows`
when provenance is irrelevant. Treat zero-length views carefully because an empty
view at an allocation boundary can produce a false-positive endpoint range.
`subslice_range` also panics for zero-sized element types.

## Strip Paired Boundaries Atomically

Use `strip_circumfix` when both boundaries must match. It removes each boundary
once and returns `None` when either boundary is absent or the two matches overlap.

```rust
assert_eq!("(payload)".strip_circumfix('(', ')'), Some("payload"));
assert_eq!("(payload".strip_circumfix('(', ')'), None);

let frame = b"<data>";
assert_eq!(frame.strip_circumfix(b"<", b">"), Some(&b"data"[..]));
```

This is clearer and safer than accepting a successful `strip_prefix` before
checking whether the corresponding suffix exists.

## Use Typed Parsing and Explicit Text Encoding

Parse non-zero integers directly into a non-zero type instead of parsing a
primitive and validating it in a second step:

```rust
use core::num::NonZeroU16;

let port = NonZeroU16::from_str_radix("1f90", 16).expect("valid non-zero port");
assert_eq!(port.get(), 8080);
```

When UTF-16 arrives as bytes, select the byte order explicitly rather than
converting to native-endian `u16` values first:

```rust
let little_endian = [0x48, 0x00, 0x69, 0x00];
let big_endian = [0x00, 0x48, 0x00, 0x69];

assert_eq!(String::from_utf16le(&little_endian).unwrap(), "Hi");
assert_eq!(String::from_utf16be(&big_endian).unwrap(), "Hi");
```

Use the corresponding lossy constructor only when replacement characters are an
accepted part of the decoding contract.

## Integer Bit Inspection

Use integer bit-inspection methods when the domain is about bit positions or
one-bit masks. They make the zero case and return shape explicit and avoid
hand-written shift arithmetic.

```rust
let flags = 0b0010_1100_u8;

assert_eq!(flags.bit_width(), 6);
assert_eq!(flags.highest_one(), Some(5));
assert_eq!(flags.lowest_one(), Some(2));
assert_eq!(flags.isolate_highest_one(), 0b0010_0000);
assert_eq!(flags.isolate_lowest_one(), 0b0000_0100);

assert_eq!(0_u8.highest_one(), None);
assert_eq!(0_u8.isolate_lowest_one(), 0);
```

Use the corresponding `NonZero` methods when zero is already excluded by the
type. Respect an explicitly declared lower MSRV instead of changing public
compatibility solely for stylistic cleanup.

## Prefer `char` Associated Items

Use the primitive type's associated constants and functions:

```rust
let replacement = char::REPLACEMENT_CHARACTER;
let decoded = char::from_u32(0x1F980);

assert_eq!(replacement, '\u{FFFD}');
assert_eq!(decoded, Some('🦀'));
```

## Imports

Group imports by origin and keep them boring:

```rust
# mod queue { pub struct WorkItem; }
# mod telemetry { pub struct SpanName; }
# fn main() {
use std::sync::Arc;
use std::time::Duration;

use tracing::Instrument;

# #[cfg(not(test))]
use crate::queue::WorkItem;
# #[cfg(not(test))]
use crate::telemetry::SpanName;
# #[cfg(test)]
# use self::queue::WorkItem;
# #[cfg(test)]
# use self::telemetry::SpanName;
# }
```

Use stable `rustfmt` defaults unless the repository already uses nightly rustfmt
for import grouping. Avoid introducing nightly-only formatting configuration just
to reshuffle imports.
