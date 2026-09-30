//! Map pure captured-reason validation to the HTTP service error contract.
use crate::error::{ApiError, Result};
use serde_json::Value;

pub(crate) fn capture(detail: &Value) -> Result<Value> {
    krine_core::capture_reason(detail).map_err(|_| ApiError::unavailable())
}
