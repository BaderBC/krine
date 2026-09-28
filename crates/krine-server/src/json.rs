//! Reject duplicate fields and excessive nesting before serde's typed decoder.
use crate::error::ApiError;
use axum::{
    body::to_bytes,
    extract::{FromRequest, Request},
    http::StatusCode,
};
use serde::de::{self, DeserializeOwned, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

pub struct StrictJson<T>(pub T);
impl<S: Send + Sync, T: DeserializeOwned + Send> FromRequest<S> for StrictJson<T> {
    type Rejection = ApiError;
    async fn from_request(req: Request, _: &S) -> Result<Self, Self::Rejection> {
        let content_type = req
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if content_type.split(';').next().map(str::trim) != Some("application/json") {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "Content-Type must be application/json.",
            ));
        }
        let bytes = to_bytes(req.into_body(), 65536).await.map_err(|_| {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "Request bodies are limited to 64 KiB.",
            )
        })?;
        decode(&bytes).map(Self)
    }
}
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let value = Seed(0).deserialize(&mut decoder).and_then(|v|{decoder.end()?;Ok(v)})
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST,"invalid_json","JSON is malformed, contains duplicate keys, invalid numbers, or excessive nesting."))?;
    serde_json::from_value(value)
        .map_err(|_| ApiError::invalid("The JSON does not match the request schema."))
}
struct Seed(usize);
impl<'de> DeserializeSeed<'de> for Seed {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        if self.0 > 64 {
            return Err(de::Error::custom("nesting limit"));
        }
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        if v.unsigned_abs() > 9_007_199_254_740_991 {
            Err(E::custom("number limit"))
        } else {
            Ok(Value::Number(v.into()))
        }
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        if v > 9_007_199_254_740_991 {
            Err(E::custom("number limit"))
        } else {
            Ok(Value::Number(v.into()))
        }
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        if !v.is_finite() || v.abs() > krine_core::MAX_SAFE_NUMBER {
            return Err(E::custom("number limit"));
        }
        if v.fract() == 0.0 {
            Ok(Value::Number((v as i64).into()))
        } else {
            Ok(serde_json::json!(v))
        }
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut v = Vec::new();
        while let Some(item) = a.next_element_seed(Seed(self.0 + 1))? {
            v.push(item);
        }
        Ok(Value::Array(v))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut v = Map::new();
        while let Some(key) = a.next_key::<String>()? {
            if v.contains_key(&key) {
                return Err(de::Error::custom("duplicate key"));
            }
            v.insert(key, a.next_value_seed(Seed(self.0 + 1))?);
        }
        Ok(Value::Object(v))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_duplicates_and_depth() {
        assert!(decode::<Value>(br#"{"a":{"b":1,"b":2}}"#).is_err());
        assert!(
            decode::<Value>(format!("{}0{}", "[".repeat(66), "]".repeat(66)).as_bytes()).is_err()
        );
    }
    #[test]
    fn equivalent_numbers() {
        assert_eq!(
            crate::util::canonical_digest(&decode::<Value>(b"{\"a\":1}").unwrap()),
            crate::util::canonical_digest(&decode::<Value>(b"{\"a\":1e0}").unwrap())
        );
    }
}
