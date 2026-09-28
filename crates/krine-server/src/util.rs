use crate::error::{ApiError, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}
pub fn token(prefix: &str) -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes))
}
pub fn digest(value: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_ref()))
}
pub fn equal(a: &str, b: &str) -> bool {
    bool::from(Sha256::digest(a.as_bytes()).ct_eq(&Sha256::digest(b.as_bytes())))
}
pub fn canonical_digest(value: &Value) -> String {
    fn normalized(value: &Value) -> Value {
        match value {
            Value::Number(n) => {
                let f = n.as_f64().unwrap_or(0.0);
                serde_json::json!(if f == 0.0 { 0.0 } else { f })
            }
            Value::Array(a) => Value::Array(a.iter().map(normalized).collect()),
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, v)| (k.clone(), normalized(v))).collect())
            }
            v => v.clone(),
        }
    }
    digest(serde_json::to_vec(&normalized(value)).expect("JSON serializes"))
}
pub fn identifier(value: &str) -> Result<()> {
    if krine_core::valid_identifier(value) {
        Ok(())
    } else {
        Err(ApiError::invalid(
            "Identifiers must contain 1–128 ASCII letters, digits, underscores, dashes, dots or colons.",
        ))
    }
}
pub fn user_identifier(value: &str) -> Result<()> {
    if !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(ApiError::invalid(
            "User identifiers must contain 1–256 bytes without control characters.",
        ))
    }
}
pub fn ip(value: &str) -> Result<std::net::IpAddr> {
    value
        .parse::<std::net::IpAddr>()
        .map(normalize_ip)
        .map_err(|_| ApiError::invalid("Expected an IP address."))
}
pub fn normalize_ip(ip: std::net::IpAddr) -> std::net::IpAddr {
    match ip {
        std::net::IpAddr::V6(v) => v.to_ipv4_mapped().map(std::net::IpAddr::V4).unwrap_or(ip),
        _ => ip,
    }
}
pub fn object_limit(value: &Value) -> Result<()> {
    fn depth(v: &Value, n: usize) -> bool {
        if n > 16 {
            return false;
        }
        match v {
            Value::Object(o) => {
                o.keys().all(|key| key.len() <= 1024) && o.values().all(|v| depth(v, n + 1))
            }
            Value::Array(a) => a.iter().all(|v| depth(v, n + 1)),
            Value::String(s) => s.len() <= 1024,
            _ => true,
        }
    }
    if !value.is_object()
        || !depth(value, 0)
        || serde_json::to_vec(value)
            .map_err(|_| ApiError::invalid("Invalid JSON object."))?
            .len()
            > 16384
    {
        Err(ApiError::invalid(
            "Properties and metadata must be objects no larger than 16 KiB.",
        ))
    } else {
        Ok(())
    }
}
