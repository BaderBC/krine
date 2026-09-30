//! Pure policy evaluation. Authentication, persistence and provider calls belong
//! to the application boundary; this crate consumes their pinned evidence.

mod catalog;
mod explanation;
mod policy;

pub use catalog::*;
pub use explanation::{ReasonCaptureError, capture_reason};
pub use policy::*;
