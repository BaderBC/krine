//! Fixed-origin adapters. Callers supply App's redirect-disabled HTTP client.
//! Never attach provider request errors or bodies to logs: IP lookup URLs contain secrets.

use std::{net::IpAddr, time::Duration};

use krine_core::{Observation, Scalar, UnknownReason, Verification};
use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const IP_ENDPOINT: &str = "https://proxycheck.io/v3/";
const VERIFY_ENDPOINT: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const IP_BUDGET: Duration = Duration::from_secs(1);
const VERIFY_BUDGET: Duration = Duration::from_millis(1500);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const TOKEN_LIFETIME_MS: i64 = 300_000;
// Accommodate small clock differences without extending the attempt deadline.
const CLOCK_SKEW_MS: i64 = 5000;
pub(crate) const VERIFY_ACTION: &str = "krine_verify";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectionStatus {
    Connected,
    Partial,
    Unavailable,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct IpObservation {
    pub risk: Observation,
    pub is_proxy: Observation,
    pub country: Observation,
    pub status: ConnectionStatus,
    pub detail: String,
    pub observed_at_ms: i64,
}

impl IpObservation {
    fn failed(failure: HttpFailure) -> Self {
        let reason = match failure {
            HttpFailure::Timeout => UnknownReason::Timeout,
            HttpFailure::Malformed | HttpFailure::TooLarge | HttpFailure::Credentials => {
                UnknownReason::Invalid
            }
            _ => UnknownReason::Unavailable,
        };
        Self {
            risk: Observation::unknown(reason),
            is_proxy: Observation::unknown(reason),
            country: Observation::unknown(reason),
            status: if reason == UnknownReason::Invalid {
                ConnectionStatus::Invalid
            } else {
                ConnectionStatus::Unavailable
            },
            detail: failure.detail().into(),
            observed_at_ms: crate::util::now(),
        }
    }
}

pub(crate) async fn lookup_ip(http: &Client, secret: Option<&str>, ip: IpAddr) -> IpObservation {
    lookup_ip_from(http, secret, ip, IP_ENDPOINT).await
}

async fn lookup_ip_from(
    http: &Client,
    secret: Option<&str>,
    ip: IpAddr,
    endpoint: &str,
) -> IpObservation {
    let ip = crate::util::normalize_ip(ip).to_string();
    let mut request = http
        .get(format!("{endpoint}{ip}"))
        .query(&[("ver", "24-June-2026"), ("tag", "0")]);
    if let Some(secret) = secret {
        request = request.query(&[("key", secret)]);
    }
    match bounded_json(request, IP_BUDGET).await {
        Ok(value) => parse_ip(value, &ip),
        Err(failure) => IpObservation::failed(failure),
    }
}

fn parse_ip(value: Value, ip: &str) -> IpObservation {
    let warning = match value.get("status").and_then(Value::as_str) {
        Some("ok") => false,
        Some("warning") => true,
        Some("denied" | "error") => return IpObservation::failed(HttpFailure::Credentials),
        _ => return IpObservation::failed(HttpFailure::Malformed),
    };
    let Some(record) = value.get(ip).filter(|record| record.is_object()) else {
        return IpObservation::failed(HttpFailure::Malformed);
    };
    let risk = ip_field(record, "detections", "risk", |value| {
        value
            .as_f64()
            .filter(|risk| risk.is_finite() && (0.0..=100.0).contains(risk))
            .map(|risk| Scalar::Number(risk / 100.0))
    });
    let is_proxy = ip_field(record, "detections", "proxy", |value| {
        value.as_bool().map(Scalar::Boolean)
    });
    let country = ip_field(record, "location", "country_code", |value| {
        value
            .as_str()
            .filter(|country| valid_country(country))
            .map(|country| Scalar::String(country.to_owned()))
    });
    let complete = [&risk, &is_proxy, &country]
        .iter()
        .all(|state| matches!(state, Observation::Known { .. }));
    IpObservation {
        risk,
        is_proxy,
        country,
        status: if complete && !warning {
            ConnectionStatus::Connected
        } else {
            ConnectionStatus::Partial
        },
        detail: if warning {
            "provider_warning"
        } else if complete {
            "lookup_succeeded"
        } else {
            "partial_observation"
        }
        .into(),
        observed_at_ms: crate::util::now(),
    }
}

fn ip_field(
    record: &Value,
    section: &str,
    field: &str,
    normalize: impl FnOnce(&Value) -> Option<Scalar>,
) -> Observation {
    let Some(section) = record.get(section).filter(|value| !value.is_null()) else {
        return Observation::unknown(UnknownReason::Missing);
    };
    if !section.is_object() {
        return Observation::unknown(UnknownReason::Invalid);
    }
    let Some(value) = section.get(field).filter(|value| !value.is_null()) else {
        return Observation::unknown(UnknownReason::Missing);
    };
    normalize(value).map_or_else(
        || Observation::unknown(UnknownReason::Invalid),
        |value| Observation::Known { value },
    )
}

fn valid_country(country: &str) -> bool {
    // ISO 3166-1 alpha-2. Provider placeholders and nonstandard codes remain unknown.
    const CODES: &str = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";
    country.len() == 2 && CODES.split_ascii_whitespace().any(|code| code == country)
}

// Intentionally not Debug: secret and response token must not appear in diagnostics.
pub(crate) struct VerificationRequest<'a> {
    pub secret: &'a str,
    pub token: &'a str,
    pub expected_hostname: &'a str,
    pub binding: &'a str,
    pub idempotency_key: &'a str,
    pub ip: IpAddr,
    pub created_at_ms: i64,
    pub deadline_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerificationResult {
    pub outcome: Verification,
    pub detail: &'static str,
}

impl VerificationResult {
    fn new(outcome: Verification, detail: &'static str) -> Self {
        Self { outcome, detail }
    }
}

pub(crate) async fn verify_turnstile(
    http: &Client,
    request: &VerificationRequest<'_>,
) -> VerificationResult {
    verify_turnstile_from(http, request, VERIFY_ENDPOINT).await
}

async fn verify_turnstile_from(
    http: &Client,
    request: &VerificationRequest<'_>,
    endpoint: &str,
) -> VerificationResult {
    let now = crate::util::now();
    if now >= request.deadline_ms {
        return VerificationResult::new(Verification::Expired, "attempt_expired");
    }
    if request.token.is_empty() || request.token.len() > 2048 {
        return VerificationResult::new(Verification::Failed, "invalid_token");
    }
    if request.secret.is_empty()
        || request.expected_hostname.is_empty()
        || request.binding.is_empty()
        || request.binding.len() > 255
        || !request
            .binding
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || request.created_at_ms > now
        || request.deadline_ms <= request.created_at_ms
        || uuid::Uuid::parse_str(request.idempotency_key).is_err()
    {
        return VerificationResult::new(Verification::Unavailable, "invalid_configuration");
    }
    let budget = VERIFY_BUDGET.min(Duration::from_millis(
        request.deadline_ms.saturating_sub(now) as u64,
    ));
    let result = bounded_json(
        http.post(endpoint).json(&serde_json::json!({
            "secret": request.secret,
            "response": request.token,
            "remoteip": crate::util::normalize_ip(request.ip).to_string(),
            "idempotency_key": request.idempotency_key,
        })),
        budget,
    )
    .await;
    let now = crate::util::now();
    if now >= request.deadline_ms {
        return VerificationResult::new(Verification::Expired, "attempt_expired");
    }
    match result {
        Ok(value) => parse_verification(value, request, now),
        Err(failure) => VerificationResult::new(Verification::Unavailable, failure.detail()),
    }
}

#[derive(Deserialize)]
struct SiteverifyResponse {
    success: bool,
    #[serde(default, rename = "error-codes")]
    errors: Vec<String>,
    challenge_ts: Option<String>,
    hostname: Option<String>,
    action: Option<String>,
    cdata: Option<String>,
}

fn parse_verification(
    value: Value,
    request: &VerificationRequest<'_>,
    now: i64,
) -> VerificationResult {
    let Ok(response) = serde_json::from_value::<SiteverifyResponse>(value) else {
        return VerificationResult::new(Verification::Unavailable, "malformed_response");
    };
    if !response.success {
        if response.errors.is_empty() {
            return VerificationResult::new(Verification::Unavailable, "malformed_response");
        }
        if response.errors.iter().any(|error| {
            !matches!(
                error.as_str(),
                "timeout-or-duplicate" | "invalid-input-response" | "missing-input-response"
            )
        }) {
            return VerificationResult::new(Verification::Unavailable, "verification_unavailable");
        }
        return if response
            .errors
            .iter()
            .any(|error| error == "timeout-or-duplicate")
        {
            VerificationResult::new(Verification::Expired, "token_expired_or_replayed")
        } else {
            VerificationResult::new(Verification::Failed, "token_rejected")
        };
    }
    if !response.errors.is_empty() {
        return VerificationResult::new(Verification::Unavailable, "malformed_response");
    }
    let (Some(hostname), Some(action), Some(binding), Some(timestamp)) = (
        response.hostname,
        response.action,
        response.cdata,
        response.challenge_ts,
    ) else {
        return VerificationResult::new(Verification::Unavailable, "malformed_response");
    };
    if !hostname.eq_ignore_ascii_case(request.expected_hostname)
        || action != VERIFY_ACTION
        || binding != request.binding
    {
        return VerificationResult::new(Verification::Failed, "binding_mismatch");
    }
    let Ok(timestamp) = OffsetDateTime::parse(&timestamp, &Rfc3339) else {
        return VerificationResult::new(Verification::Unavailable, "malformed_response");
    };
    let timestamp_ms = timestamp.unix_timestamp_nanos() / 1_000_000;
    if timestamp_ms < i128::from(request.created_at_ms.saturating_sub(CLOCK_SKEW_MS))
        || timestamp_ms > i128::from(now.saturating_add(CLOCK_SKEW_MS))
    {
        return VerificationResult::new(Verification::Failed, "timestamp_mismatch");
    }
    if i128::from(now) - timestamp_ms >= i128::from(TOKEN_LIFETIME_MS) {
        return VerificationResult::new(Verification::Expired, "token_expired");
    }
    VerificationResult::new(Verification::Passed, "verification_passed")
}

#[derive(Clone, Copy)]
enum HttpFailure {
    Timeout,
    Unavailable,
    Credentials,
    Redirect,
    HttpStatus,
    TooLarge,
    Malformed,
}

impl HttpFailure {
    fn detail(self) -> &'static str {
        match self {
            Self::Timeout => "provider_timeout",
            Self::Unavailable => "provider_unavailable",
            Self::Credentials => "provider_credentials_rejected",
            Self::Redirect => "provider_redirect_rejected",
            Self::HttpStatus => "provider_http_error",
            Self::TooLarge => "response_too_large",
            Self::Malformed => "malformed_response",
        }
    }

    fn from_request(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else {
            Self::Unavailable
        }
    }
}

async fn bounded_json(request: RequestBuilder, budget: Duration) -> Result<Value, HttpFailure> {
    tokio::time::timeout(budget, async {
        let mut response = request
            .timeout(budget)
            .send()
            .await
            .map_err(HttpFailure::from_request)?;
        let status = response.status();
        if status.is_redirection() {
            return Err(HttpFailure::Redirect);
        }
        if matches!(status.as_u16(), 401 | 403) {
            return Err(HttpFailure::Credentials);
        }
        if !status.is_success() {
            return Err(HttpFailure::HttpStatus);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(HttpFailure::TooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(HttpFailure::from_request)? {
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                return Err(HttpFailure::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        crate::json::decode(&bytes).map_err(|_| HttpFailure::Malformed)
    })
    .await
    .map_err(|_| HttpFailure::Timeout)?
}

#[cfg(test)]
pub(crate) async fn lookup_ip_at(
    http: &Client,
    secret: Option<&str>,
    ip: IpAddr,
    endpoint: &str,
) -> IpObservation {
    lookup_ip_from(http, secret, ip, endpoint).await
}

#[cfg(test)]
pub(crate) async fn verify_turnstile_at(
    http: &Client,
    request: &VerificationRequest<'_>,
    endpoint: &str,
) -> VerificationResult {
    verify_turnstile_from(http, request, endpoint).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
        task::JoinHandle,
        time::{Instant, sleep, timeout},
    };

    const IP: &str = "8.8.8.8";
    const IDEMPOTENCY: &str = "90a85c2e-0f38-4a20-8fc4-6873ba775216";

    fn client() -> Client {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap()
    }

    fn request(now: i64) -> VerificationRequest<'static> {
        VerificationRequest {
            secret: "test-secret",
            token: "test-response",
            expected_hostname: "shop.example",
            binding: "step_binding_123",
            idempotency_key: IDEMPOTENCY,
            ip: IP.parse().unwrap(),
            created_at_ms: now - 1000,
            deadline_ms: now + 299_000,
        }
    }

    fn timestamp(ms: i64) -> String {
        let date = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).unwrap();
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            date.year(),
            u8::from(date.month()),
            date.day(),
            date.hour(),
            date.minute(),
            date.second(),
            date.millisecond()
        )
    }

    fn verified(now: i64) -> Value {
        json!({
            "success": true,
            "error-codes": [],
            "challenge_ts": timestamp(now),
            "hostname": "shop.example",
            "action": VERIFY_ACTION,
            "cdata": "step_binding_123"
        })
    }

    fn intelligence() -> Value {
        json!({
            "status": "ok",
            IP: {
                "detections": {"risk": 75, "proxy": false, "vpn": true},
                "location": {"country_code": "US"}
            }
        })
    }

    struct Server {
        url: String,
        request: oneshot::Receiver<Vec<u8>>,
        task: JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn server(parts: Vec<(Duration, Vec<u8>)>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (send, request) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let length = socket.read(&mut chunk).await.unwrap();
                if length == 0 {
                    return;
                }
                bytes.extend_from_slice(&chunk[..length]);
                if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index]);
                    let body_length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|length| length.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= index + 4 + body_length {
                        break;
                    }
                }
            }
            let _ = send.send(bytes);
            for (delay, bytes) in parts {
                sleep(delay).await;
                if socket.write_all(&bytes).await.is_err() {
                    return;
                }
            }
        });
        Server { url, request, task }
    }

    fn http_response(status: &str, body: impl AsRef<[u8]>) -> Vec<u8> {
        let body = body.as_ref();
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    async fn json_server(value: Value) -> Server {
        server(vec![(
            Duration::ZERO,
            http_response("200 OK", value.to_string()),
        )])
        .await
    }

    fn known(value: Scalar) -> Observation {
        Observation::Known { value }
    }

    #[test]
    fn intelligence_uses_live_v3_fields_and_preserves_false() {
        let observation = parse_ip(intelligence(), IP);
        assert_eq!(observation.risk, known(Scalar::Number(0.75)));
        assert_eq!(observation.is_proxy, known(Scalar::Boolean(false)));
        assert_eq!(observation.country, known(Scalar::String("US".into())));
        assert_eq!(observation.status, ConnectionStatus::Connected);
        assert_eq!(
            serde_json::from_value::<IpObservation>(serde_json::to_value(&observation).unwrap())
                .unwrap(),
            observation
        );
    }

    #[test]
    fn intelligence_normalizes_boundaries_and_reports_invalid_fields_individually() {
        for (risk, expected) in [
            (json!(0), known(Scalar::Number(0.0))),
            (json!(100), known(Scalar::Number(1.0))),
            (json!(12.5), known(Scalar::Number(0.125))),
            (json!(null), Observation::unknown(UnknownReason::Missing)),
            (json!(-1), Observation::unknown(UnknownReason::Invalid)),
            (json!(101), Observation::unknown(UnknownReason::Invalid)),
            (json!("75"), Observation::unknown(UnknownReason::Invalid)),
            (json!(false), Observation::unknown(UnknownReason::Invalid)),
        ] {
            let mut value = intelligence();
            value[IP]["detections"]["risk"] = risk;
            let observation = parse_ip(value, IP);
            assert_eq!(observation.risk, expected);
            assert_eq!(observation.is_proxy, known(Scalar::Boolean(false)));
            assert_eq!(observation.country, known(Scalar::String("US".into())));
        }
    }

    #[test]
    fn intelligence_preserves_missing_null_and_invalid_sections() {
        for value in [
            json!({"status":"ok", IP:{}}),
            json!({"status":"ok", IP:{"detections":null,"location":null}}),
            json!({"status":"ok", IP:{"detections":{"risk":null,"proxy":null},"location":{"country_code":null}}}),
        ] {
            let result = parse_ip(value, IP);
            assert_eq!(result.risk, Observation::unknown(UnknownReason::Missing));
            assert_eq!(
                result.is_proxy,
                Observation::unknown(UnknownReason::Missing)
            );
            assert_eq!(result.country, Observation::unknown(UnknownReason::Missing));
            assert_eq!(result.status, ConnectionStatus::Partial);
        }
        let result = parse_ip(
            json!({"status":"ok", IP:{"detections":[],"location":"US"}}),
            IP,
        );
        assert_eq!(result.risk, Observation::unknown(UnknownReason::Invalid));
        assert_eq!(
            result.is_proxy,
            Observation::unknown(UnknownReason::Invalid)
        );
        assert_eq!(result.country, Observation::unknown(UnknownReason::Invalid));
    }

    #[test]
    fn intelligence_rejects_string_booleans_and_non_country_codes() {
        for country in [
            json!("usa"),
            json!("us"),
            json!("ZZ"),
            json!("XK"),
            json!(4),
        ] {
            let mut value = intelligence();
            value[IP]["location"]["country_code"] = country;
            value[IP]["detections"]["proxy"] = json!("no");
            let result = parse_ip(value, IP);
            assert_eq!(result.country, Observation::unknown(UnknownReason::Invalid));
            assert_eq!(
                result.is_proxy,
                Observation::unknown(UnknownReason::Invalid)
            );
            assert_eq!(result.risk, known(Scalar::Number(0.75)));
        }
    }

    #[test]
    fn intelligence_rejects_missing_or_incompatible_roots_and_preserves_warnings() {
        for value in [
            json!([]),
            json!(null),
            json!({}),
            json!({"status":"ok"}),
            json!({"status":"ok",IP:[]}),
            json!({"status":"error",IP:{}}),
            json!({"status":"denied",IP:{}}),
        ] {
            let result = parse_ip(value, IP);
            assert_eq!(result.status, ConnectionStatus::Invalid);
            assert_eq!(result.risk, Observation::unknown(UnknownReason::Invalid));
        }
        let mut value = intelligence();
        value["status"] = json!("warning");
        let result = parse_ip(value, IP);
        assert_eq!(result.status, ConnectionStatus::Partial);
        assert_eq!(result.detail, "provider_warning");
        assert_eq!(result.risk, known(Scalar::Number(0.75)));
    }

    #[tokio::test]
    async fn lookup_encodes_secret_pins_version_and_normalizes_mapped_ip() {
        let mut server = json_server(intelligence()).await;
        let result = lookup_ip_at(
            &client(),
            Some("key?&private=data"),
            "::ffff:8.8.8.8".parse().unwrap(),
            &server.url,
        )
        .await;
        assert_eq!(result.status, ConnectionStatus::Connected);
        let bytes = (&mut server.request).await.unwrap();
        let request = String::from_utf8(bytes).unwrap();
        let target = request.lines().next().unwrap().split(' ').nth(1).unwrap();
        let target = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
        assert_eq!(target.path(), "/8.8.8.8");
        let query: std::collections::BTreeMap<_, _> = target.query_pairs().collect();
        assert_eq!(query["ver"], "24-June-2026");
        assert_eq!(query["tag"], "0");
        assert_eq!(query["key"], "key?&private=data");
        assert!(!format!("{result:?}").contains("private=data"));
    }

    #[tokio::test]
    async fn lookup_without_key_and_ipv6_have_the_same_protocol() {
        let ip = "2001:4860:4860::8888";
        let mut value = intelligence();
        value[ip] = value[IP].take();
        let mut server = json_server(value).await;
        let result = lookup_ip_at(&client(), None, ip.parse().unwrap(), &server.url).await;
        assert_eq!(result.status, ConnectionStatus::Connected);
        let bytes = (&mut server.request).await.unwrap();
        let request = String::from_utf8(bytes).unwrap();
        assert!(request.starts_with("GET /2001:4860:4860::8888?ver=24-June-2026&tag=0 "));
        assert!(!request.contains("key="));
    }

    #[tokio::test]
    async fn lookup_http_and_json_failures_never_become_safe_data() {
        for (status, body, expected, detail) in [
            (
                "401 Unauthorized",
                "secret reflected",
                ConnectionStatus::Invalid,
                "provider_credentials_rejected",
            ),
            (
                "403 Forbidden",
                "secret reflected",
                ConnectionStatus::Invalid,
                "provider_credentials_rejected",
            ),
            (
                "429 Too Many Requests",
                "rate limit",
                ConnectionStatus::Unavailable,
                "provider_http_error",
            ),
            (
                "503 Unavailable",
                "outage",
                ConnectionStatus::Unavailable,
                "provider_http_error",
            ),
            (
                "200 OK",
                "not json",
                ConnectionStatus::Invalid,
                "malformed_response",
            ),
        ] {
            let server = server(vec![(Duration::ZERO, http_response(status, body))]).await;
            let result = lookup_ip_at(&client(), None, IP.parse().unwrap(), &server.url).await;
            assert_eq!(result.status, expected);
            assert_eq!(result.detail, detail);
            assert!(matches!(result.risk, Observation::Unknown { .. }));
            assert!(!format!("{result:?}").contains(body));
        }
    }

    #[tokio::test]
    async fn lookup_never_follows_redirects_or_sends_key_to_redirect_target() {
        let mut target = json_server(intelligence()).await;
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            target.url
        );
        let server = server(vec![(Duration::ZERO, response.into_bytes())]).await;
        let result =
            lookup_ip_at(&client(), Some("secret"), IP.parse().unwrap(), &server.url).await;
        assert_eq!(result.detail, "provider_redirect_rejected");
        assert!(
            timeout(Duration::from_millis(50), &mut target.request)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn lookup_bounds_content_length_and_chunked_bodies() {
        let chunk = " ".repeat(MAX_RESPONSE_BYTES + 1);
        for response in [
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            ),
            format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{chunk}\r\n0\r\n\r\n",
                chunk.len()
            ),
        ] {
            let server = server(vec![(Duration::ZERO, response.into_bytes())]).await;
            let result = lookup_ip_at(&client(), None, IP.parse().unwrap(), &server.url).await;
            assert_eq!(result.detail, "response_too_large");
            assert_eq!(result.risk, Observation::unknown(UnknownReason::Invalid));
        }
    }

    #[tokio::test]
    async fn lookup_accepts_exact_body_limit() {
        let mut body = intelligence().to_string();
        body.push_str(&" ".repeat(MAX_RESPONSE_BYTES - body.len()));
        let server = server(vec![(Duration::ZERO, http_response("200 OK", body))]).await;
        let result = lookup_ip_at(&client(), None, IP.parse().unwrap(), &server.url).await;
        assert_eq!(result.status, ConnectionStatus::Connected);
    }

    #[tokio::test]
    async fn lookup_budget_covers_headers_and_streamed_body_together() {
        let body = intelligence().to_string();
        let headers = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
        let server = server(vec![
            (Duration::from_millis(600), headers.into_bytes()),
            (Duration::from_millis(600), body.into_bytes()),
        ])
        .await;
        let start = Instant::now();
        let result = lookup_ip_at(&client(), None, IP.parse().unwrap(), &server.url).await;
        assert_eq!(result.risk, Observation::unknown(UnknownReason::Timeout));
        assert_eq!(result.detail, "provider_timeout");
        assert!(start.elapsed() < Duration::from_millis(1600));
    }

    #[tokio::test]
    async fn network_connection_failure_is_unavailable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        drop(listener);
        let result = lookup_ip_at(&client(), None, IP.parse().unwrap(), &endpoint).await;
        assert_eq!(result.status, ConnectionStatus::Unavailable);
        assert_eq!(
            result.risk,
            Observation::unknown(UnknownReason::Unavailable)
        );
    }

    #[test]
    fn verification_requires_strict_success_and_consistent_error_codes() {
        let now = crate::util::now();
        let request = request(now);
        for value in [
            json!({}),
            json!({"success":"true"}),
            json!({"success":1}),
            json!({"success":false}),
            json!({"success":false,"error-codes":[]}),
            json!({"success":false,"error-codes":"invalid-input-response"}),
            json!({"success":true,"error-codes":["invalid-input-response"]}),
            json!({"success":true,"error-codes":[42]}),
        ] {
            let result = parse_verification(value, &request, now);
            assert_eq!(result.outcome, Verification::Unavailable);
            assert_eq!(result.detail, "malformed_response");
        }
    }

    #[test]
    fn verification_checks_every_binding_including_public_dummy_keys() {
        let now = crate::util::now();
        for secret in ["test-secret", "1x0000000000000000000000000000000AA"] {
            let mut request = request(now);
            request.secret = secret;
            assert_eq!(
                parse_verification(verified(now), &request, now).outcome,
                Verification::Passed
            );
            for (field, bad) in [
                ("hostname", "attacker.example"),
                ("hostname", "shop.example.attacker.test"),
                ("action", "login"),
                ("cdata", "different_attempt"),
                ("cdata", ""),
            ] {
                let mut value = verified(now);
                value[field] = json!(bad);
                let result = parse_verification(value, &request, now);
                assert_eq!(result.outcome, Verification::Failed);
                assert_eq!(result.detail, "binding_mismatch");
            }
            for field in ["hostname", "action", "cdata", "challenge_ts"] {
                for invalid in [json!(null), json!(42), json!([])] {
                    let mut value = verified(now);
                    value[field] = invalid;
                    assert_eq!(
                        parse_verification(value, &request, now).outcome,
                        Verification::Unavailable
                    );
                }
                let mut value = verified(now);
                value.as_object_mut().unwrap().remove(field);
                assert_eq!(
                    parse_verification(value, &request, now).outcome,
                    Verification::Unavailable
                );
            }
        }
    }

    #[test]
    fn verification_timestamp_is_bound_to_step_and_current_time() {
        let now = crate::util::now();
        let mut request = request(now);
        for (ms, outcome) in [
            (request.created_at_ms - CLOCK_SKEW_MS, Verification::Passed),
            (
                request.created_at_ms - CLOCK_SKEW_MS - 1,
                Verification::Failed,
            ),
            (now + CLOCK_SKEW_MS, Verification::Passed),
            (now + CLOCK_SKEW_MS + 1, Verification::Failed),
        ] {
            let mut value = verified(ms);
            value["hostname"] = json!("SHOP.EXAMPLE");
            assert_eq!(parse_verification(value, &request, now).outcome, outcome);
        }
        request.created_at_ms = now - TOKEN_LIFETIME_MS;
        assert_eq!(
            parse_verification(verified(now - TOKEN_LIFETIME_MS), &request, now).outcome,
            Verification::Expired
        );
        let mut value = verified(now);
        value["challenge_ts"] = json!("yesterday");
        assert_eq!(
            parse_verification(value, &request, now).outcome,
            Verification::Unavailable
        );
    }

    #[test]
    fn verification_maps_provider_rejection_and_unavailability() {
        let now = crate::util::now();
        let request = request(now);
        for (errors, outcome) in [
            (vec!["invalid-input-response"], Verification::Failed),
            (vec!["missing-input-response"], Verification::Failed),
            (vec!["timeout-or-duplicate"], Verification::Expired),
            (vec!["invalid-input-secret"], Verification::Unavailable),
            (vec!["missing-input-secret"], Verification::Unavailable),
            (vec!["bad-request"], Verification::Unavailable),
            (vec!["internal-error"], Verification::Unavailable),
            (vec!["new-provider-error"], Verification::Unavailable),
            (
                vec!["timeout-or-duplicate", "internal-error"],
                Verification::Unavailable,
            ),
        ] {
            assert_eq!(
                parse_verification(json!({"success":false,"error-codes":errors}), &request, now)
                    .outcome,
                outcome
            );
        }
    }

    #[tokio::test]
    async fn verification_posts_exact_pinned_fields_and_accepts_valid_response() {
        let now = crate::util::now();
        let request = request(now);
        let mut server = json_server(verified(now)).await;
        let result = verify_turnstile_at(&client(), &request, &server.url).await;
        assert_eq!(result.outcome, Verification::Passed);
        let bytes = (&mut server.request).await.unwrap();
        assert!(bytes.starts_with(b"POST / HTTP/1.1\r\n"));
        let index = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes[index + 4..]).unwrap();
        assert_eq!(
            value,
            json!({"secret":"test-secret","response":"test-response","remoteip":IP,"idempotency_key":IDEMPOTENCY})
        );
        assert!(!format!("{result:?}").contains("test-secret"));
        assert!(!format!("{result:?}").contains("test-response"));
    }

    #[tokio::test]
    async fn verification_expired_attempts_and_bad_tokens_never_call_provider() {
        let now = crate::util::now();
        let mut request = request(now);
        let mut server = json_server(verified(now)).await;
        request.deadline_ms = now;
        assert_eq!(
            verify_turnstile_at(&client(), &request, &server.url)
                .await
                .outcome,
            Verification::Expired
        );
        for token in ["".to_owned(), "x".repeat(2049)] {
            let request = VerificationRequest {
                token: &token,
                deadline_ms: now + 299_000,
                ..request
            };
            assert_eq!(
                verify_turnstile_at(&client(), &request, &server.url)
                    .await
                    .outcome,
                Verification::Failed
            );
        }
        assert!(
            timeout(Duration::from_millis(50), &mut server.request)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn verification_invalid_pinned_configuration_never_calls_provider() {
        let now = crate::util::now();
        let mut server = json_server(verified(now)).await;
        for field in ["secret", "binding", "hostname", "uuid", "created"] {
            let mut request = request(now);
            match field {
                "secret" => request.secret = "",
                "binding" => request.binding = "hostile&binding",
                "hostname" => request.expected_hostname = "",
                "uuid" => request.idempotency_key = "not-a-uuid",
                "created" => request.created_at_ms = now + 60_000,
                _ => unreachable!(),
            }
            assert_eq!(
                verify_turnstile_at(&client(), &request, &server.url)
                    .await
                    .outcome,
                Verification::Unavailable
            );
        }
        assert!(
            timeout(Duration::from_millis(50), &mut server.request)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn verification_obeys_original_deadline_during_response_reading() {
        let now = crate::util::now();
        let mut request = request(now);
        request.deadline_ms = now + 100;
        let server = server(vec![(
            Duration::from_millis(200),
            http_response("200 OK", verified(now).to_string()),
        )])
        .await;
        let result = verify_turnstile_at(&client(), &request, &server.url).await;
        assert_eq!(result.outcome, Verification::Expired);
        assert_eq!(result.detail, "attempt_expired");
    }

    #[tokio::test]
    async fn verification_has_a_whole_request_budget() {
        let now = crate::util::now();
        let request = request(now);
        let body = verified(now).to_string();
        let server = server(vec![
            (
                Duration::from_millis(900),
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes(),
            ),
            (Duration::from_millis(900), body.into_bytes()),
        ])
        .await;
        let result = verify_turnstile_at(&client(), &request, &server.url).await;
        assert_eq!(result.outcome, Verification::Unavailable);
        assert_eq!(result.detail, "provider_timeout");
    }

    #[tokio::test]
    async fn verification_rejects_redirects_malformed_and_oversized_responses() {
        let now = crate::util::now();
        let request = request(now);
        for (response, detail) in [
            ("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:9/\r\nContent-Length: 0\r\n\r\n".as_bytes().to_vec(), "provider_redirect_rejected"),
            (http_response("200 OK", "invalid-json"), "malformed_response"),
            (http_response("200 OK", "{\"success\":false,\"success\":true}"), "malformed_response"),
            (http_response("200 OK", "x".repeat(MAX_RESPONSE_BYTES + 1)), "response_too_large"),
            (http_response("503 Unavailable", "outage"), "provider_http_error"),
        ] {
            let server = server(vec![(Duration::ZERO, response)]).await;
            let result = verify_turnstile_at(&client(), &request, &server.url).await;
            assert_eq!(result.outcome, Verification::Unavailable);
            assert_eq!(result.detail, detail);
        }
    }
}
