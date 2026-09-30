//! Installation context is separate from credentials and connection health.
use crate::{App, error::Result};
use axum::{Json, extract::State};
use serde_json::{Value, json};
use sqlx::Row;

pub(crate) async fn detail(State(app): State<App>) -> Result<Json<Value>> {
    let row = sqlx::query("SELECT dataset_id,generator_version,seed,range_from,range_to,completed_at FROM demo_import_state WHERE singleton AND completed_at IS NOT NULL")
        .fetch_optional(&app.db)
        .await?;
    let sample_data = row.map(|row| {
        json!({
            "dataset_id": row.get::<String, _>("dataset_id"),
            "generator_version": row.get::<String, _>("generator_version"),
            "seed": row.get::<String, _>("seed"),
            "from": row.get::<i64, _>("range_from"),
            "to": row.get::<i64, _>("range_to"),
            "completed_at": row.get::<i64, _>("completed_at"),
        })
    });
    Ok(Json(json!({"sample_data":sample_data})))
}
