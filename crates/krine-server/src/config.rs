use ipnet::IpNet;
use std::{env, net::SocketAddr, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    pub valkey_url: String,
    pub clickhouse_url: String,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
    pub public_key: String,
    pub server_secret: String,
    pub admin_password: String,
    pub local_sign_in: bool,
    pub public_url: String,
    pub admin_origin: String,
    pub allowed_origins: Vec<String>,
    pub trusted_proxies: Vec<IpNet>,
    pub development: bool,
    pub max_pending_outbox: i64,
    pub history_retention_days: i64,
    pub browser_rate: i64,
    pub server_rate: i64,
    pub login_rate: i64,
}
impl Config {
    pub fn load() -> Result<Self, String> {
        let development = env::var("KRINE_DEVELOPMENT").as_deref() == Ok("true");
        let public_url = required("KRINE_PUBLIC_URL")?;
        let admin_origin = env::var("KRINE_ADMIN_ORIGIN").unwrap_or_else(|_| public_url.clone());
        let allowed_origins = required("KRINE_ALLOWED_ORIGINS")?
            .split(',')
            .map(|s| s.trim().to_owned())
            .collect::<Vec<_>>();
        for origin in allowed_origins.iter().chain([&admin_origin, &public_url]) {
            validate_origin(origin, development)?;
        }
        let result = Self {
            bind: env::var("KRINE_BIND")
                .unwrap_or_else(|_| "127.0.0.1:8080".into())
                .parse()
                .map_err(|_| "Invalid KRINE_BIND")?,
            database_url: required("KRINE_DATABASE_URL")?,
            valkey_url: required("KRINE_VALKEY_URL")?,
            clickhouse_url: required("KRINE_CLICKHOUSE_URL")?,
            clickhouse_user: env::var("KRINE_CLICKHOUSE_USER").unwrap_or_else(|_| "krine".into()),
            clickhouse_password: required("KRINE_CLICKHOUSE_PASSWORD")?,
            public_key: required("KRINE_PUBLIC_KEY")?,
            server_secret: required("KRINE_SERVER_SECRET")?,
            admin_password: required("KRINE_ADMIN_PASSWORD")?,
            local_sign_in: match env::var("KRINE_LOCAL_SIGN_IN").as_deref() {
                Ok("false") => false,
                Ok("true") | Err(_) => true,
                _ => return Err("KRINE_LOCAL_SIGN_IN must be true or false".into()),
            },
            public_url,
            admin_origin,
            allowed_origins,
            development,
            trusted_proxies: env::var("KRINE_TRUSTED_PROXIES")
                .unwrap_or_default()
                .split(',')
                .filter(|s| !s.is_empty())
                .map(|s| {
                    s.trim()
                        .parse()
                        .map_err(|_| "Invalid trusted proxy CIDR".to_owned())
                })
                .collect::<Result<_, _>>()?,
            history_retention_days: retention_days(
                env::var("KRINE_HISTORY_RETENTION_DAYS").ok().as_deref(),
            )?,
            browser_rate: positive("KRINE_BROWSER_RATE_PER_MINUTE", 300)?,
            server_rate: positive("KRINE_SERVER_RATE_PER_MINUTE", 3000)?,
            login_rate: positive("KRINE_LOGIN_RATE_PER_MINUTE", 10)?,
            max_pending_outbox: env::var("KRINE_MAX_PENDING_OUTBOX")
                .unwrap_or_else(|_| "1000000".into())
                .parse()
                .map_err(|_| "Invalid outbox capacity")?,
        };
        if result.server_secret.len() < 32
            || result.public_key.len() < 16
            || result.admin_password.len() < 16
            || result.max_pending_outbox < 1
        {
            return Err("Secrets or outbox capacity do not meet minimum requirements".into());
        }
        crate::credentials::validate_bootstrap(&result)?;
        Ok(result)
    }
}
fn required(name: &str) -> Result<String, String> {
    let direct = env::var(name).ok();
    let file = env::var(format!("{name}_FILE")).ok();
    match (direct, file) {
        (Some(_), Some(_)) => Err(format!("Set only {name} or {name}_FILE")),
        (Some(v), None) if !v.is_empty() => Ok(v),
        (None, Some(path)) => std::fs::read_to_string(PathBuf::from(path))
            .map(|v| v.trim_end_matches(['\r', '\n']).to_owned())
            .map_err(|_| format!("Cannot read {name}_FILE")),
        _ => Err(format!("Missing {name}")),
    }
}
fn validate_origin(value: &str, development: bool) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid origin")?;
    if url.origin().ascii_serialization() != value
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.scheme() != "https" && !(development && url.scheme() == "http"))
    {
        return Err(
            "Origins must be exact HTTPS origins; HTTP requires KRINE_DEVELOPMENT=true".into(),
        );
    }
    Ok(())
}

fn positive(name: &str, default: i64) -> Result<i64, String> {
    let value = env::var(name).map_or(Ok(default), |value| {
        value.parse().map_err(|_| format!("Invalid {name}"))
    })?;
    if !(1..=1_000_000).contains(&value) {
        return Err(format!("{name} must be between 1 and 1000000"));
    }
    Ok(value)
}

fn retention_days(value: Option<&str>) -> Result<i64, String> {
    let days = value
        .unwrap_or("30")
        .parse::<i64>()
        .map_err(|_| "Invalid KRINE_HISTORY_RETENTION_DAYS")?;
    if !(2..=3650).contains(&days) {
        return Err("KRINE_HISTORY_RETENTION_DAYS must be between 2 and 3650".into());
    }
    Ok(days)
}

#[cfg(test)]
mod tests {
    #[test]
    fn retention_is_bounded_and_explicit() {
        assert_eq!(super::retention_days(None).unwrap(), 30);
        for value in ["2", "30", "3650"] {
            assert_eq!(
                super::retention_days(Some(value)).unwrap().to_string(),
                value
            );
        }
        for value in [
            "",
            "0",
            "1",
            "-2",
            "3651",
            "2.5",
            "forever",
            "9223372036854775808",
        ] {
            assert!(super::retention_days(Some(value)).is_err());
        }
    }
}
