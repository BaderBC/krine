//! Query selectors preserve opaque identifiers that URL path normalization can erase.
use crate::{
    App, admin, entities,
    error::{ApiError, Result},
    history, investigation,
    json::StrictJson,
    relationships, util,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::HeaderMap,
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::Value;

type Selection<T> = std::result::Result<Query<T>, QueryRejection>;
fn selection<T>(query: Selection<T>) -> Result<T> {
    query.map(|Query(value)| value).map_err(|_| {
        ApiError::invalid("Provide one valid value for each supported selector parameter.")
    })
}

pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/admin/lookup/checks", get(check))
        .route("/v1/admin/lookup/checks/draft", put(draft))
        .route("/v1/admin/lookup/checks/publications", post(publish))
        .route("/v1/admin/lookup/checks/restorations", post(restore_check))
        .route("/v1/admin/lookup/checks/versions", get(versions))
        .route("/v1/admin/lookup/checks/versions/{version}", get(version))
        .route("/v1/admin/lookup/events", get(event))
        .route("/v1/admin/lookup/entities", get(entity))
        .route("/v1/admin/lookup/entities/context", get(entity_context))
        .route(
            "/v1/admin/lookup/entities/timeline",
            get(investigation::timeline),
        )
        .route(
            "/v1/admin/lookup/entities/relationships",
            get(entity_relationships),
        )
        .route("/v1/admin/lookup/relationships", get(relationship))
        .route("/v1/admin/lookup/relationships/corrections", post(correct))
        .route(
            "/v1/admin/lookup/relationships/restorations",
            post(restore_relationship),
        )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Check {
    name: String,
}
impl Check {
    fn name(self) -> Result<String> {
        util::identifier(&self.name)?;
        Ok(self.name)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckPage {
    name: String,
    limit: Option<i64>,
    cursor: Option<String>,
    q: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Event {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entity {
    kind: String,
    id: String,
    associations_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Relationship {
    kind: String,
    id: String,
}
impl Relationship {
    fn key(self) -> Result<(String, String)> {
        if !["backend", "observed_ip"].contains(&self.kind.as_str()) {
            return Err(ApiError::absent());
        }
        util::identifier(&self.id)?;
        Ok((self.kind, self.id))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RelationshipPage {
    kind: String,
    id: String,
    limit: Option<i64>,
    cursor: Option<String>,
}
pub(crate) fn entity_key(kind: String, id: String) -> Result<(String, String)> {
    match kind.as_str() {
        "user" => util::user_identifier(&id)?,
        "client" | "session" => util::identifier(&id)?,
        "ip" => {
            util::ip(&id)?;
        }
        _ => return Err(ApiError::absent()),
    }
    Ok((kind, id))
}

async fn check(state: State<App>, query: Selection<Check>) -> Result<Json<Value>> {
    admin::get_check(state, Path(selection(query)?.name()?)).await
}
async fn draft(
    state: State<App>,
    query: Selection<Check>,
    headers: HeaderMap,
    input: StrictJson<admin::Draft>,
) -> Result<Json<Value>> {
    admin::save_draft(state, Path(selection(query)?.name()?), headers, input).await
}
async fn publish(
    state: State<App>,
    query: Selection<Check>,
    headers: HeaderMap,
    input: StrictJson<admin::Publication>,
) -> Result<Json<Value>> {
    admin::publish(state, Path(selection(query)?.name()?), headers, input).await
}
async fn restore_check(
    state: State<App>,
    query: Selection<Check>,
    headers: HeaderMap,
    input: StrictJson<admin::Restoration>,
) -> Result<Json<Value>> {
    admin::restore(state, Path(selection(query)?.name()?), headers, input).await
}
async fn versions(state: State<App>, query: Selection<CheckPage>) -> Result<Json<Value>> {
    let page = selection(query)?;
    util::identifier(&page.name)?;
    admin::versions(
        state,
        Path(page.name),
        Ok(Query(admin::List {
            limit: page.limit,
            cursor: page.cursor,
            q: page.q,
        })),
    )
    .await
}
async fn version(
    state: State<App>,
    Path(version): Path<i64>,
    query: Selection<Check>,
) -> Result<Json<Value>> {
    admin::version(state, Path((selection(query)?.name()?, version))).await
}
async fn event(state: State<App>, query: Selection<Event>) -> Result<Json<Value>> {
    let selected = selection(query)?;
    util::identifier(&selected.id)?;
    history::event(state, Path(selected.id)).await
}
async fn entity(state: State<App>, query: Selection<Entity>) -> Result<Json<Value>> {
    let selected = selection(query)?;
    entities::detail(
        state,
        Path(entity_key(selected.kind, selected.id)?),
        Ok(Query(entities::EntityQuery {
            associations_cursor: selected.associations_cursor,
        })),
    )
    .await
}
async fn entity_context(state: State<App>, query: Selection<Entity>) -> Result<Json<Value>> {
    let selected = selection(query)?;
    let (kind, id) = entity_key(selected.kind, selected.id)?;
    let (mut context, at) = entities::context(
        &state.0,
        &kind,
        &id,
        Ok(Query(entities::EntityQuery {
            associations_cursor: selected.associations_cursor,
        })),
    )
    .await?;
    context["observed_at"] = serde_json::json!(at);
    Ok(Json(context))
}
async fn entity_relationships(
    state: State<App>,
    query: Selection<RelationshipPage>,
) -> Result<Json<Value>> {
    let selected = selection(query)?;
    relationships::list(
        state,
        Path(entity_key(selected.kind, selected.id)?),
        Ok(Query(relationships::Page {
            limit: selected.limit,
            cursor: selected.cursor,
        })),
    )
    .await
}
async fn relationship(
    state: State<App>,
    query: Selection<RelationshipPage>,
) -> Result<Json<Value>> {
    let selected = selection(query)?;
    let key = Relationship {
        kind: selected.kind,
        id: selected.id,
    }
    .key()?;
    relationships::detail(
        state,
        Path(key),
        Ok(Query(relationships::Page {
            limit: selected.limit,
            cursor: selected.cursor,
        })),
    )
    .await
}
async fn correct(
    state: State<App>,
    query: Selection<Relationship>,
    headers: HeaderMap,
    input: StrictJson<relationships::Correction>,
) -> Result<Json<Value>> {
    relationships::correct(state, Path(selection(query)?.key()?), headers, input).await
}
async fn restore_relationship(
    state: State<App>,
    query: Selection<Relationship>,
    headers: HeaderMap,
    input: StrictJson<relationships::Correction>,
) -> Result<Json<Value>> {
    relationships::restore(state, Path(selection(query)?.key()?), headers, input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Uri;

    #[test]
    fn selectors_reject_duplicates_and_decode_exactly_once() {
        for query in [
            "kind=user&id=.&id=..",
            "kind=user&kind=client&id=.",
            "kind=user&id=.&unsupported=x",
        ] {
            assert!(
                Query::<Entity>::try_from_uri(
                    &format!("/v1/admin/lookup/entities?{query}")
                        .parse::<Uri>()
                        .unwrap()
                )
                .is_err()
            );
        }
        assert!(
            Query::<Check>::try_from_uri(
                &"/v1/admin/lookup/checks?name=.&name=..".parse().unwrap()
            )
            .is_err()
        );
        for (encoded, literal) in [
            (".", "."),
            ("..", ".."),
            ("%252e", "%2e"),
            ("%E7%94%A8%E6%88%B7%2Fa%3Fb%23c%25", "用户/a?b#c%"),
        ] {
            let Query(selected) = Query::<Entity>::try_from_uri(
                &format!("/v1/admin/lookup/entities?kind=user&id={encoded}")
                    .parse()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(selected.id, literal);
            assert_eq!(entity_key(selected.kind, selected.id).unwrap().1, literal);
        }
    }
}
