# Comments vs Documentation

## Contents

* [Comments versus rustdoc](#comments-vs-rustdoc)
* [Good and bad comments](#good-comments-explain-why)
* [Replace narration with structure](#replace-long-comments-with-structure)
* [Track TODOs](#todos-should-become-issues)
* [Document public APIs](#public-api-documentation)
* [Rustdoc checklist](#rustdoc-checklist)

Clear code beats comments that explain what the code already says. Use comments
for context that cannot be represented cleanly in names, types, tests, or public
documentation.

## Comments vs Rustdoc

| Need | Use `//` comment | Use `///` or `//!` docs |
| --- | --- | --- |
| Explain local reasoning or trade-off | Yes | Usually no |
| Document public API behavior | No | Yes |
| Describe safety invariants | Yes, especially near `unsafe` | Yes for public unsafe APIs |
| Provide examples | Rarely | Yes, with doc tests |
| Link to ADR/design context | Yes | Sometimes |

## Good Comments Explain Why

```rust
// PERF: Keep the small lookup table inline; benchmarks showed the heap-backed
// version regressed parser throughput for short frames.
const FAST_PATH_LIMITS: [u16; 4] = [8, 16, 32, 64];
```

Use named prefixes for recurring comment types:

* `SAFETY:` for unsafe invariants.
* `PERF:` for measured performance trade-offs.
* `COMPAT:` for compatibility constraints.
* `CONTEXT:` for design or operational background.

```rust
# let slice = [42_u8];
# let index = 0;
# let ptr = slice.as_ptr();
# assert!(index < slice.len());
// SAFETY: `ptr` came from `slice.as_ptr()` and `index < slice.len()` was checked
// immediately above, so the computed address is in-bounds for a shared read.
let value = unsafe { *ptr.add(index) };
```

This illustrates explaining an unsafe invariant, not a reason to introduce raw
pointers. Prefer safe indexing or `get` when those operations express the task.

## Bad Comments Restate Code

```rust
fn advance(offset: &mut usize) {
    // increment offset by one
    *offset += 1;
}
```

Prefer a better name, a smaller function, or a test that names the behavior.

## Replace Long Comments with Structure

Instead of narrating every step, extract functions with names that encode intent.

```rust
# struct Frame { payload: Option<Vec<u8>> }
# #[derive(Clone, Copy, Debug)]
# struct IngestError;
# fn validate_frame_header(frame: &Frame) -> Result<(), IngestError> {
#     frame.payload.as_ref().filter(|payload| !payload.is_empty()).map(|_| ()).ok_or(IngestError)
# }
# fn decode_payload(frame: Frame) -> Result<Vec<u8>, IngestError> {
#     frame.payload.ok_or(IngestError)
# }
# fn store_payload(payload: Vec<u8>) -> Result<(), IngestError> {
#     (!payload.is_empty()).then_some(()).ok_or(IngestError)
# }
fn ingest_frame(frame: Frame) -> Result<(), IngestError> {
    validate_frame_header(&frame)?;
    let payload = decode_payload(frame)?;
    store_payload(payload)
}
```

Tests can then document each stage:

```rust
# fn validate_frame_header_rejects(input: &str) -> bool { !input.contains("kind:") }
# fn decode_payload_rejects(input: &[u8]) -> bool { input.last() != Some(&0) }
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_frame_header_rejects_missing_kind() {
#         assert!(validate_frame_header_rejects("payload:data"));
        // ...
    }

    #[test]
    fn decode_payload_rejects_invalid_checksum() {
#         assert!(decode_payload_rejects(&[1, 2, 3]));
        // ...
    }
}
```

## TODOs Should Become Issues

Do not leave vague TODOs in code. Link to a trackable issue and include the exit
condition.

```rust
// TODO(issue #412): Remove legacy checksum compatibility after v3 payloads are
// no longer accepted by the ingestion API.
```

## Public API Documentation

Use `///` for public items and include behavior, errors, panics, safety, and
examples where relevant.

```rust
# pub struct Marker(String);
# impl Marker {
#     pub fn as_str(&self) -> &str { &self.0 }
# }
# #[derive(Debug, thiserror::Error)]
# pub enum MarkerError {
#     #[error("marker is empty")]
#     Empty,
# }
/// Parses a wire marker into a normalized lowercase marker.
///
/// # Errors
///
/// Returns [`MarkerError::Empty`] when `input` contains only whitespace.
///
/// # Examples
///
/// ```rust
/// # use crate_name::{parse_marker, Marker};
/// let marker = parse_marker(" Ready ")?;
/// assert_eq!(marker.as_str(), "ready");
/// # Ok::<(), crate_name::MarkerError>(())
/// ```
pub fn parse_marker(input: &str) -> Result<Marker, MarkerError> {
    // ...
#     let marker = input.trim();
#     if marker.is_empty() {
#         return Err(MarkerError::Empty);
#     }
#     Ok(Marker(marker.to_ascii_lowercase()))
}
```

Use `//!` for module or crate-level documentation.

```rust
//! Queue coordination primitives.
//!
//! This module owns lease acquisition, renewal, and release for worker queues.
//! Callers should use [`Lease`] rather than storing raw lease tokens.
```

## Rustdoc Checklist

* Crate root has `//!` docs that explain what problem the crate solves.
* Public modules explain their invariants and main exports.
* Public structs/enums/traits explain their role and invariants.
* Public fallible functions have `# Errors`.
* Public panicking functions have `# Panics`.
* Public unsafe functions have `# Safety`.
* Examples compile under `cargo test --doc` unless intentionally marked.
* Intra-doc links are checked with `rustdoc::broken_intra_doc_links`.
