//! Two owned reads, independent of caller lifetime and fenced at ClickHouse.
use crate::{
    error::{ApiError, Result},
    util,
};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, oneshot},
    task::JoinSet,
};

const DEADLINE: Duration = Duration::from_secs(10);

tokio::task_local! {
    static QUERY_ID: String;
}

pub(crate) fn query_id() -> Option<String> {
    QUERY_ID.try_with(Clone::clone).ok()
}

pub(crate) struct Reads {
    ids: [String; 2],
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    busy: [bool; 2],
    closed: bool,
    jobs: JoinSet<()>,
}
impl Default for Reads {
    fn default() -> Self {
        let prefix = util::token("krine-analysis-");
        Self {
            ids: [format!("{prefix}-0"), format!("{prefix}-1")],
            state: Mutex::new(State::default()),
        }
    }
}

struct Slot {
    reads: Arc<Reads>,
    index: usize,
    _permit: OwnedSemaphorePermit,
}
impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut state) = self.reads.state.lock() {
            state.busy[self.index] = false;
        }
    }
}

impl Reads {
    pub(crate) async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        permit: OwnedSemaphorePermit,
        operation: impl Future<Output = Result<T>> + Send + 'static,
    ) -> Result<T> {
        let (send, receive) = oneshot::channel();
        {
            let mut state = self.state.lock().map_err(|_| ApiError::unavailable())?;
            if state.closed {
                return Err(ApiError::unavailable());
            }
            while state.jobs.try_join_next().is_some() {}
            let index = state
                .busy
                .iter()
                .position(|busy| !busy)
                .ok_or_else(ApiError::unavailable)?;
            state.busy[index] = true;
            // The same ID scopes every sequential preparation/read request.
            // Spawned child tasks do not inherit Tokio task-locals: dependency
            // calls must remain in this owned future, not detached helpers.
            // A transport failure cannot make its prior execution replaceable.
            let operation = QUERY_ID.scope(self.ids[index].clone(), operation);
            let slot = Slot {
                reads: self.clone(),
                index,
                _permit: permit,
            };
            state.jobs.spawn(async move {
                let result = tokio::time::timeout(DEADLINE, operation)
                    .await
                    .unwrap_or_else(|_| Err(ApiError::unavailable()));
                let _ = send.send(result);
                drop(slot);
            });
        }
        receive.await.map_err(|_| ApiError::unavailable())?
    }

    pub(crate) async fn shutdown(&self) {
        let mut jobs = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.closed = true;
            std::mem::take(&mut state.jobs)
        };
        // Each job has its own whole-request deadline. Waiting here keeps
        // caller-abandoned work tracked through ordinary graceful shutdown.
        while jobs.join_next().await.is_some() {}
    }

    #[cfg(test)]
    pub(crate) fn query_ids(&self) -> &[String; 2] {
        &self.ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn caller_cancellation_cannot_escape_the_operation_deadline_or_shutdown() {
        let reads = Arc::new(Reads::default());
        let admission = Arc::new(tokio::sync::Semaphore::new(2));
        let permit = admission.clone().try_acquire_owned().unwrap();
        let owner = reads.clone();
        let (entered, started) = oneshot::channel();
        let caller = tokio::spawn(async move {
            owner
                .run(permit, async move {
                    let _ = entered.send(query_id());
                    std::future::pending::<Result<()>>().await
                })
                .await
        });
        assert!(started.await.unwrap().is_some());
        assert!(
            query_id().is_none(),
            "ordinary work does not inherit the owned operation's ID"
        );
        caller.abort();
        assert_eq!(admission.available_permits(), 1);
        let started = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(12), reads.shutdown())
            .await
            .unwrap();
        assert!(started.elapsed() >= Duration::from_secs(9));
        assert_eq!(admission.available_permits(), 2);
        assert!(
            reads
                .run(admission.try_acquire_owned().unwrap(), async { Ok(()) })
                .await
                .is_err()
        );
    }
}
