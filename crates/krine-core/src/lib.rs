//! Pure policy evaluation. Authentication, persistence and provider calls belong
//! to the application boundary; this crate consumes their pinned evidence.

mod catalog;
mod policy;

pub use catalog::*;
pub use policy::*;
