mod admin;
mod auth;
mod browser;
mod checks;
pub mod config;
mod connection;
mod credentials;
mod entities;
pub mod error;
mod events;
mod explanation;
mod history;
mod json;
mod projection;
mod provider_http;
mod providers;
mod relationships;
mod retention;
mod util;

use axum::{
    Router, middleware,
    routing::{get, post, put},
};
use config::Config;
use error::{ApiError, Result};
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{sync::Arc, time::Duration};

/// Durable identity of the application credential that authenticated a request.
#[derive(Clone)]
pub struct ApplicationCredential {
    pub id: String,
}

#[derive(Clone)]
pub struct App {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub redis: ConnectionManager,
    pub http: reqwest::Client,
    #[cfg(test)]
    provider_test: ProviderTest,
}
impl App {
    pub async fn connect(
        config: Config,
    ) -> std::result::Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        credentials::validate_bootstrap(&config)?;
        let db = PgPoolOptions::new()
            .max_connections(20)
            .acquire_timeout(Duration::from_secs(2))
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET krine.writer_generation='5'")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET statement_timeout='3s'")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET lock_timeout='1s'")
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(&config.database_url)
            .await?;
        {
            let mut connection = db.acquire().await?;
            // Migration 0004 updates generation-3 rows before later guards.
            // Preserve that upgrade path without admitting old writers.
            sqlx::query("SET krine.writer_generation='3'")
                .execute(&mut *connection)
                .await?;
            sqlx::migrate!("../../migrations")
                .run_direct(&mut *connection)
                .await?;
            sqlx::query("SET krine.writer_generation='5'")
                .execute(&mut *connection)
                .await?;
        }
        history::configure_retention(&db, config.history_retention_days)
            .await
            .map_err(|_| "Could not configure analytical retention")?;
        credentials::bootstrap(&db, &config)
            .await
            .map_err(|_| "Could not initialize application credentials")?;
        let redis = ConnectionManager::new_with_config(
            redis::Client::open(config.valkey_url.as_str())?,
            ConnectionManagerConfig::new()
                .set_number_of_retries(0)
                .set_max_delay(100)
                .set_connection_timeout(Duration::from_secs(2))
                .set_response_timeout(Duration::from_secs(2)),
        )
        .await?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            config: Arc::new(config),
            db,
            redis,
            http,
            #[cfg(test)]
            provider_test: ProviderTest::default(),
        })
    }
}
pub fn router(app: App) -> Router {
    Router::new()
        .route("/health/live", get(|| async { "ok" }))
        .route("/health/ready", get(ready))
        .route("/v1/browser/context", post(browser::context))
        .route("/v1/browser/proofs", post(browser::proof))
        .route("/v1/contexts/resolve", post(browser::resolve))
        .route("/v1/events", post(events::ingest))
        .route("/v1/associations", post(events::associate))
        .route("/v1/checks/evaluate", post(checks::evaluate))
        .route(
            "/v1/admin/session",
            post(auth::login).get(auth::current).delete(auth::logout),
        )
        .route(
            "/v1/admin/checks",
            get(admin::list_checks).post(admin::create_check),
        )
        .route("/v1/admin/checks/{name}", get(admin::get_check))
        .route("/v1/admin/checks/{name}/draft", put(admin::save_draft))
        .route("/v1/admin/checks/{name}/publications", post(admin::publish))
        .route("/v1/admin/checks/{name}/versions", get(admin::versions))
        .route(
            "/v1/admin/checks/{name}/versions/{version}",
            get(admin::version),
        )
        .route("/v1/admin/checks/{name}/restorations", post(admin::restore))
        .route("/v1/admin/metrics", get(admin::metrics))
        .route(
            "/v1/admin/metrics/{name}/versions/{version}",
            get(admin::metric),
        )
        .route("/v1/admin/entities/{kind}/{id}", get(entities::detail))
        .route(
            "/v1/admin/entities/{kind}/{id}/relationships",
            get(relationships::list),
        )
        .route(
            "/v1/admin/relationships/{kind}/{id}",
            get(relationships::detail),
        )
        .route(
            "/v1/admin/relationships/{kind}/{id}/corrections",
            post(relationships::correct),
        )
        .route(
            "/v1/admin/relationships/{kind}/{id}/restorations",
            post(relationships::restore),
        )
        .route("/v1/admin/setup", get(connection::setup))
        .route(
            "/v1/admin/credentials",
            get(credentials::list).post(credentials::create),
        )
        .route(
            "/v1/admin/credentials/{id}/revocations",
            post(credentials::revoke),
        )
        .route("/v1/admin/providers", get(providers::list))
        .route("/v1/admin/providers/{capability}", put(providers::save))
        .route(
            "/v1/admin/providers/{capability}/tests",
            post(providers::test),
        )
        .route("/v1/admin/activity/events", get(history::events))
        .route("/v1/admin/activity/events/{id}", get(history::event))
        .route("/v1/admin/activity/decisions", get(history::decisions))
        .route("/v1/admin/activity/decisions/{id}", get(history::decision))
        .fallback(|| async { ApiError::absent() })
        .layer(middleware::from_fn_with_state(app.clone(), auth::boundary))
        .with_state(app)
}
async fn ready(
    axum::extract::State(app): axum::extract::State<App>,
) -> Result<axum::Json<serde_json::Value>> {
    sqlx::query("SELECT 1").execute(&app.db).await?;
    projection::ensure_ready(&app).await?;
    Ok(axum::Json(serde_json::json!({"status":"ready"})))
}
pub async fn worker(app: App, shutdown: tokio::sync::watch::Receiver<bool>) {
    tokio::join!(
        export_worker(app.clone(), shutdown.clone()),
        retention::worker(app, shutdown)
    );
}
async fn export_worker(app: App, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! { _=shutdown.changed()=>break,_=interval.tick()=> {
            match tokio::time::timeout(Duration::from_secs(5),projection::ensure_ready(&app)).await {Ok(Ok(()))=>{},Ok(Err(e))=>tracing::warn!(code=e.code,"projection recovery pending"),Err(_)=>tracing::warn!("projection recovery deadline exceeded")}
            if let Err(e)=checks::expire_pending(&app).await{tracing::warn!(code=e.code,"challenge expiry pending");}
            if let Err(e)=history::export(&app).await{tracing::warn!(code=e.code,"history export pending");}
        }}
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
struct ProviderTest {
    ip_endpoint: Option<String>,
    verify_endpoint: Option<String>,
    history_suffix: String,
    lose_cleanup_ack: bool,
    after_verification: Option<std::sync::Arc<VerificationPause>>,
    after_export: Option<std::sync::Arc<VerificationPause>>,
}

#[cfg(test)]
mod provider_integration;

#[cfg(test)]
#[derive(Default)]
struct VerificationPause {
    arrived: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}
