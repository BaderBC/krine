use krine_server::{App, config::Config};
mod dashboard;
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "krine_server=info".into()),
        )
        .init();
    if let Err(message) = run().await {
        tracing::error!(message, "server stopped");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let config = Config::load()?;
    let bind = config.bind;
    let app = App::connect(config).await.map_err(|_| {
        "Required database initialization failed; check configuration and dependency health."
            .to_owned()
    })?;
    let mut router = krine_server::router(app.clone());
    if let Some(directory) = std::env::var_os("KRINE_DASHBOARD_DIR") {
        router = dashboard::attach(router, std::path::Path::new(&directory))?;
    }
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|_| "Cannot bind HTTP listener".to_owned())?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let worker = tokio::spawn(krine_server::worker(app.clone(), shutdown_rx));
    tracing::info!(%bind,"Krine listening");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        let _ = shutdown_tx.send(true);
    })
    .await
    .map_err(|_| "HTTP service failed".to_owned())?;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), worker).await;
    Ok(())
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
