use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
    pub details: Vec<Value>,
    pub dependency: Option<&'static str>,
}
impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
            details: Vec::new(),
            dependency: None,
        }
    }
    pub fn invalid(message: &'static str) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_input", message)
    }
    pub fn conflict(code: &'static str) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            code,
            "The request conflicts with recorded state.",
        )
    }
    pub fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "A required dependency is unavailable. Retry with the same request identity.",
        )
    }
    pub fn valkey() -> Self {
        let mut error = Self::unavailable();
        error.dependency = Some("valkey");
        error
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthenticated",
            "Authentication is required.",
        )
    }
    pub fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "The request is not permitted.",
        )
    }
    pub fn absent() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "The resource does not exist.",
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let retry =
            self.status == StatusCode::TOO_MANY_REQUESTS || self.code == "operation_in_progress";
        let mut response = (self.status, Json(json!({"error":{"code":self.code,"message":self.message,"request_id":crate::util::token("req_"),"details":self.details}}))).into_response();
        if retry {
            response
                .headers_mut()
                .insert("retry-after", "1".parse().expect("static header"));
        }
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::warn!(kind = "postgres", error = %error.as_database_error().map(|e| e.code().unwrap_or_default()).unwrap_or_default(), "dependency failure");
        let mut error = Self::unavailable();
        error.dependency = Some("postgres");
        error
    }
}
impl From<redis::RedisError> for ApiError {
    fn from(_: redis::RedisError) -> Self {
        Self::valkey()
    }
}
impl From<krine_core::ValidationError> for ApiError {
    fn from(error: krine_core::ValidationError) -> Self {
        let mut result = Self::invalid("The policy or inputs are invalid.");
        result
            .details
            .push(json!({"path":error.path,"message":error.message}));
        result
    }
}
pub type Result<T> = std::result::Result<T, ApiError>;

/// An offline importer owns this installation until its read-back completes.
#[derive(Debug)]
pub(crate) struct IncompleteDemoImport;
impl std::fmt::Display for IncompleteDemoImport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Demonstration import is incomplete; resume its isolated importer.")
    }
}
impl std::error::Error for IncompleteDemoImport {}

/// Startup diagnostics must not format arbitrary database errors or credentials.
pub fn startup_message(error: &(dyn std::error::Error + 'static)) -> &'static str {
    if error.is::<IncompleteDemoImport>() {
        "Demonstration import is incomplete; resume its isolated importer."
    } else {
        "Required database initialization failed; check configuration and dependency health."
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    #[test]
    fn only_the_known_import_state_has_an_actionable_diagnostic() {
        assert_eq!(
            startup_message(&IncompleteDemoImport),
            "Demonstration import is incomplete; resume its isolated importer."
        );
        let arbitrary = std::io::Error::other("postgres://operator:secret@example.test/krine");
        assert_eq!(
            startup_message(&arbitrary),
            "Required database initialization failed; check configuration and dependency health."
        );
        let similar = std::io::Error::other("Demonstration import is incomplete; password=secret");
        assert_eq!(startup_message(&similar), startup_message(&arbitrary));
    }
}
