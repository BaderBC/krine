use crate::{
    App,
    error::{ApiError, Result},
    util,
};
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::{IpAddr, SocketAddr};

#[derive(Clone, Copy)]
pub struct Peer(pub IpAddr);
pub use crate::operators::{current, login, logout};
pub fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    {
        let mut values = headers.get_all(name).iter();
        let value = values.next()?;
        if values.next().is_some() {
            return None;
        }
        value.to_str().ok()
    }
}
pub fn source_ip(app: &App, headers: &HeaderMap, peer: IpAddr) -> Result<IpAddr> {
    let peer = util::normalize_ip(peer);
    if !app
        .config
        .trusted_proxies
        .iter()
        .any(|net| net.contains(&peer))
    {
        return Ok(peer);
    }
    let Some(value) = header(headers, "x-forwarded-for") else {
        return Ok(peer);
    };
    if value.len() > 2048 {
        return Err(ApiError::invalid("Forwarding chain is too long."));
    }
    let chain = value
        .split(',')
        .map(|s| util::ip(s.trim()))
        .collect::<Result<Vec<_>>>()?;
    if chain.len() > 32 {
        return Err(ApiError::invalid("Forwarding chain is too long."));
    }
    let mut current = peer;
    for next in chain.into_iter().rev() {
        if !app
            .config
            .trusted_proxies
            .iter()
            .any(|net| net.contains(&current))
        {
            break;
        }
        current = next;
    }
    Ok(current)
}
pub async fn boundary(State(app): State<App>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let origin = header(request.headers(), "origin").map(str::to_owned);
    let browser = path.starts_with("/v1/browser/");
    let admin = path.starts_with("/v1/admin/");
    let result: Result<Option<Response>> =
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            if path == "/health/live" || path == "/health/ready" {
                return Ok(None);
            }
            let peer = request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .ok_or_else(ApiError::forbidden)?
                .0
                .ip();
            let peer = source_ip(&app, request.headers(), peer)?;
            request.extensions_mut().insert(Peer(peer));
            if request.method() == Method::OPTIONS && browser {
                if !origin
                    .as_ref()
                    .is_some_and(|o| app.config.allowed_origins.contains(o))
                {
                    return Err(ApiError::forbidden());
                }
                return Ok(Some(StatusCode::NO_CONTENT.into_response()));
            }
            if browser {
                if !origin
                    .as_ref()
                    .is_some_and(|o| app.config.allowed_origins.contains(o))
                {
                    return Err(ApiError::forbidden());
                }
                let public_key = header(request.headers(), "x-krine-public-key")
                    .ok_or_else(ApiError::unauthorized)?;
                let credential = crate::credentials::authenticate(
                    &app,
                    crate::credentials::Kind::Browser,
                    public_key,
                )
                .await?;
                request.extensions_mut().insert(credential);
                rate(
                    &app,
                    &format!("browser:{peer}"),
                    app.config.browser_rate,
                    60,
                )
                .await?;
            } else if admin {
                let mutation = request.method() != Method::GET && request.method() != Method::HEAD;
                if mutation && origin.as_deref() != Some(&app.config.admin_origin) {
                    return Err(ApiError::forbidden());
                }
                if crate::operators::public_route(&path, request.method()) {
                    if mutation {
                        rate(&app, &format!("login:{peer}"), app.config.login_rate, 60).await?;
                    }
                } else {
                    let session = crate::operators::session(&app, request.headers()).await?;
                    crate::query::validate_encoding(request.uri().query())?;
                    let template = request
                        .extensions()
                        .get::<axum::extract::MatchedPath>()
                        .map(|p| p.as_str())
                        .unwrap_or("");
                    let capability = crate::operators::route_capability(template, request.method())
                        .ok_or_else(|| {
                            if [Method::GET, Method::POST, Method::PUT, Method::DELETE]
                                .iter()
                                .any(|method| {
                                    crate::operators::route_capability(template, method).is_some()
                                })
                            {
                                ApiError::new(
                                    StatusCode::METHOD_NOT_ALLOWED,
                                    "method_not_allowed",
                                    "This method is not supported for the resource.",
                                )
                            } else {
                                crate::operators::insufficient()
                            }
                        })?;
                    session.require(capability)?;
                    if mutation {
                        crate::operators::check_intent(request.headers(), &session)?;
                        let key = header(request.headers(), "idempotency-key")
                            .ok_or_else(|| ApiError::invalid("Idempotency-Key is required."))?;
                        util::identifier(key)?;
                    }
                    request.extensions_mut().insert(session);
                }
            } else if path.starts_with("/v1/") {
                let secret = header(request.headers(), "authorization")
                    .and_then(|s| s.strip_prefix("Bearer "))
                    .ok_or_else(ApiError::unauthorized)?;
                let credential = crate::credentials::authenticate(
                    &app,
                    crate::credentials::Kind::Server,
                    secret,
                )
                .await?;
                request.extensions_mut().insert(credential);
                rate(&app, "server", app.config.server_rate, 60).await?;
            }
            Ok(None)
        })
        .await
        .unwrap_or_else(|_| Err(ApiError::unavailable()));
    let mut response = match result {
        Ok(Some(r)) => r,
        Ok(None) => {
            match tokio::time::timeout(std::time::Duration::from_secs(10), next.run(request)).await
            {
                Ok(r) => r,
                Err(_) => ApiError::unavailable().into_response(),
            }
        }
        Err(e) => e.into_response(),
    };
    if browser
        && origin
            .as_ref()
            .is_some_and(|o| app.config.allowed_origins.contains(o))
    {
        if let Some(value) = origin.and_then(|s| s.parse().ok()) {
            response
                .headers_mut()
                .insert("access-control-allow-origin", value);
        }
        response
            .headers_mut()
            .insert("vary", "Origin".parse().expect("header"));
        response.headers_mut().insert(
            "access-control-allow-methods",
            "POST, OPTIONS".parse().expect("header"),
        );
        response.headers_mut().insert(
            "access-control-allow-headers",
            "Content-Type, X-Krine-Public-Key".parse().expect("header"),
        );
    }
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().expect("header"));
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().expect("header"));
    response
}
pub async fn rate(app: &App, subject: &str, limit: i64, seconds: i64) -> Result<()> {
    let key = format!(
        "krine:rate:{}:{}",
        util::digest(subject),
        util::now() / (seconds * 1000)
    );
    let count:i64=redis::Script::new("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n").key(key).arg(seconds+1).invoke_async(&mut app.redis.clone()).await?;
    if count > limit {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Request rate exceeded.",
        ));
    }
    Ok(())
}
