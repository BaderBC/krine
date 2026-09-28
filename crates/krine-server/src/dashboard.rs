use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use krine_server::error::ApiError;
use std::{collections::HashMap, fs, path::Path, sync::Arc};

struct Asset {
    bytes: Bytes,
    content_type: &'static str,
}

/// Only the immutable build directory is read, once, before accepting requests.
pub fn attach(api: Router, directory: &Path) -> Result<Router, String> {
    let mut assets = HashMap::new();
    let mut remaining = 32 * 1024 * 1024;
    load(directory, "", &mut assets, &mut remaining)?;
    if !assets.contains_key("/index.html") {
        return Err("Dashboard build is missing index.html".into());
    }
    Ok(api.fallback_service(Router::new().fallback(serve).with_state(Arc::new(assets))))
}

fn load(
    directory: &Path,
    prefix: &str,
    assets: &mut HashMap<String, Asset>,
    remaining: &mut usize,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|_| "Cannot read dashboard build")? {
        let entry = entry.map_err(|_| "Cannot read dashboard entry")?;
        let kind = entry
            .file_type()
            .map_err(|_| "Cannot inspect dashboard entry")?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Invalid dashboard filename")?;
        if name.starts_with('.') || name.contains(['%', '\\']) || kind.is_symlink() {
            return Err("Dashboard build contains an unsafe entry".into());
        }
        let path = format!("{prefix}/{name}");
        if kind.is_dir() {
            if path.matches('/').count() > 8 {
                return Err("Dashboard build exceeds directory limit".into());
            }
            load(&entry.path(), &path, assets, remaining)?;
            continue;
        }
        if !kind.is_file() {
            return Err("Dashboard build contains a non-file entry".into());
        }
        let content_type = match entry.path().extension().and_then(|s| s.to_str()) {
            Some("html") if path == "/index.html" => "text/html; charset=utf-8",
            Some("js") => "text/javascript; charset=utf-8",
            Some("css") => "text/css; charset=utf-8",
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("ico") => "image/x-icon",
            Some("woff2") => "font/woff2",
            _ => return Err("Dashboard build contains an unsupported asset".into()),
        };
        let length = entry
            .metadata()
            .map_err(|_| "Cannot inspect dashboard asset")?
            .len();
        if length > 8 * 1024 * 1024 || length > *remaining as u64 || assets.len() >= 256 {
            return Err("Dashboard build exceeds asset limits".into());
        }
        let bytes = fs::read(entry.path()).map_err(|_| "Cannot read dashboard asset")?;
        *remaining = remaining
            .checked_sub(bytes.len())
            .ok_or("Dashboard build exceeds size limit")?;
        assets.insert(
            path,
            Asset {
                bytes: bytes.into(),
                content_type,
            },
        );
    }
    Ok(())
}

async fn serve(State(assets): State<Arc<HashMap<String, Asset>>>, request: Request) -> Response {
    let path = request.uri().path();
    let reserved = ["/v1", "/health"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")));
    if reserved {
        return ApiError::absent().into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "GET, HEAD")],
        )
            .into_response();
    }
    let asset = assets.get(path).or_else(|| {
        let accepts_html = request
            .headers()
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(',')
                    .any(|part| part.trim().split(';').next() == Some("text/html"))
            });
        // Entity identifiers and metric names legitimately contain dots or
        // percent-encoded characters. Navigation never maps them to a file.
        let dashboard_route = matches!(
            path.split('/').nth(1),
            Some("" | "checks" | "activity" | "entities" | "metrics" | "settings")
        );
        (accepts_html && dashboard_route)
            .then(|| assets.get("/index.html"))
            .flatten()
    });
    let Some(asset) = asset else {
        return ApiError::absent().into_response();
    };
    let body = if request.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(asset.bytes.clone())
    };
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        asset.content_type.parse().expect("static content type"),
    );
    headers.insert(header::CONTENT_LENGTH, asset.bytes.len().into());
    headers.insert(
        header::CACHE_CONTROL,
        "no-cache".parse().expect("static header"),
    );
    headers.insert(
        "x-content-type-options",
        "nosniff".parse().expect("static header"),
    );
    headers.insert(
        "referrer-policy",
        "no-referrer".parse().expect("static header"),
    );
    headers.insert("x-frame-options", "DENY".parse().expect("static header"));
    headers.insert("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'".parse().expect("static CSP"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fallback_preserves_api_boundaries_and_asset_types() {
        let mut assets = HashMap::new();
        assets.insert(
            "/index.html".into(),
            Asset {
                bytes: Bytes::from_static(b"dashboard"),
                content_type: "text/html; charset=utf-8",
            },
        );
        assets.insert(
            "/assets/app.js".into(),
            Asset {
                bytes: Bytes::from_static(b"script"),
                content_type: "text/javascript; charset=utf-8",
            },
        );
        let assets = Arc::new(assets);
        for path in [
            "/v1",
            "/v1/missing",
            "/health/missing",
            "/assets/missing.js",
            "/.env",
            "/%2e%2e/secret",
            "/favicon.ico",
        ] {
            let request = Request::builder()
                .uri(path)
                .header(header::ACCEPT, "text/html")
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                serve(State(assets.clone()), request).await.status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        for path in [
            "/checks/can_register",
            "/metrics/client.age_seconds",
            "/entities/ip/127.0.0.1",
            "/entities/user/alice%40example.com",
            "/entities/ip/2001%3Adb8%3A%3A1",
        ] {
            let request = Request::builder()
                .uri(path)
                .header(header::ACCEPT, "text/html,application/xhtml+xml")
                .body(Body::empty())
                .unwrap();
            let response = serve(State(assets.clone()), request).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "text/html; charset=utf-8"
            );
            assert!(
                response.headers()["content-security-policy"]
                    .to_str()
                    .unwrap()
                    .contains("frame-ancestors 'none'")
            );
        }
        let request = Request::builder()
            .uri("/assets/app.js")
            .method(Method::HEAD)
            .body(Body::empty())
            .unwrap();
        let response = serve(State(assets.clone()), request).await;
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "6");
        assert!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap()
                .is_empty()
        );
        let request = Request::builder()
            .uri("/checks")
            .method(Method::POST)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            serve(State(assets), request).await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[test]
    fn build_loader_rejects_accidental_secret_files() {
        let dir = std::env::temp_dir().join(format!("krine-dashboard-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("index.html"), b"dashboard").unwrap();
        assert!(attach(Router::new(), &dir).is_ok());
        fs::write(dir.join(".env"), b"secret").unwrap();
        assert!(attach(Router::new(), &dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
