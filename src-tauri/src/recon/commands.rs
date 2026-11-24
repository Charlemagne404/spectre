use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use hickory_resolver::TokioResolver;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::recon::{
    model::ReconEvent,
    providers::{
        common::{emit, phase, provider_state, ProviderContext},
        ct, dns, rdap, ripe,
    },
    target::{normalize_target, NormalizedTarget},
};

#[derive(Default)]
pub struct ReconState {
    jobs: Mutex<HashMap<String, CancellationToken>>,
}

#[tauri::command]
pub fn start_recon(
    app: AppHandle,
    state: State<'_, ReconState>,
    job_id: String,
    target: String,
    on_event: Channel<ReconEvent>,
) -> Result<NormalizedTarget, String> {
    let job_id = Uuid::parse_str(&job_id)
        .map_err(|_| "Invalid RECON operation identifier.".to_owned())?
        .to_string();
    let target = normalize_target(&target)?;
    let cancel = CancellationToken::new();
    {
        let mut jobs = state
            .jobs
            .lock()
            .map_err(|_| "RECON job state is unavailable.".to_owned())?;
        if jobs.contains_key(&job_id) {
            return Err("That RECON operation is already active.".to_owned());
        }
        if jobs.len() >= 2 {
            return Err(
                "Two RECON jobs are already active. Cancel one before starting another.".to_owned(),
            );
        }
        jobs.insert(job_id.clone(), cancel.clone());
    }

    let result = target.clone();
    tauri::async_runtime::spawn(async move {
        run_job(job_id.clone(), target, on_event, cancel).await;
        if let Ok(mut jobs) = app.state::<ReconState>().jobs.lock() {
            jobs.remove(&job_id);
        }
    });
    Ok(result)
}

#[tauri::command]
pub fn cancel_recon(state: State<'_, ReconState>, job_id: String) -> Result<bool, String> {
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "RECON job state is unavailable.".to_owned())?;
    Ok(jobs
        .get(&job_id)
        .map(|job| {
            job.cancel();
            true
        })
        .unwrap_or(false))
}

async fn run_job(
    job_id: String,
    target: NormalizedTarget,
    on_event: Channel<ReconEvent>,
    cancel: CancellationToken,
) {
    let mut start = ReconEvent::new(&job_id, 0, "initializing", "phase");
    start.status = Some("running".to_owned());
    start.message = Some("Passive collection is active. DNS uses the system resolver; public providers receive the entered hostname or discovered public IPs.".to_owned());
    let bootstrap_context = ProviderContext {
        job_id: job_id.clone(),
        target: target.clone(),
        resolver: match TokioResolver::builder_tokio().and_then(|builder| builder.build()) {
            Ok(resolver) => resolver,
            Err(error) => {
                let mut event = ReconEvent::new(&job_id, 1, "initializing", "provider");
                event.provider = Some("dns".to_owned());
                event.status = Some("error".to_owned());
                event.message = Some(format!("System resolver is unavailable: {error}"));
                let _ = on_event.send(event);
                let mut done = ReconEvent::new(&job_id, 2, "complete", "complete");
                done.status = Some("error".to_owned());
                done.message = Some("No provider collection could start because the system resolver is unavailable.".to_owned());
                let _ = on_event.send(done);
                return;
            }
        },
        requests: std::sync::Arc::new(Semaphore::new(4)),
        cancel: cancel.clone(),
        channel: on_event,
        sequence: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        event_lock: std::sync::Arc::new(AsyncMutex::new(())),
        provider_statuses: std::sync::Arc::new(AsyncMutex::new(HashMap::new())),
    };
    emit(&bootstrap_context, start).await;

    let operation = async {
        phase(&bootstrap_context, "dns", "starting").await;
        let dns_result = dns::collect(&bootstrap_context).await;
        if bootstrap_context.cancel.is_cancelled() {
            return;
        }

        phase(&bootstrap_context, "public-data", "starting").await;
        let ((), ()) = tokio::join!(
            rdap::collect(&bootstrap_context),
            ct::collect(&bootstrap_context)
        );
        if bootstrap_context.cancel.is_cancelled() {
            return;
        }

        phase(&bootstrap_context, "routing", "starting").await;
        ripe::enrich(&bootstrap_context, dns_result.public_ips).await;
    };

    let timed_out = tokio::select! {
        _ = cancel.cancelled() => false,
        result = tokio::time::timeout(Duration::from_secs(60), operation) => result.is_err(),
    };
    if timed_out {
        cancel.cancel();
        let statuses = bootstrap_context.provider_statuses.lock().await.clone();
        for (provider, status) in statuses {
            if status == "running" {
                provider_state(
                    &bootstrap_context,
                    &provider,
                    "error",
                    Some("Overall investigation deadline of 60 seconds reached.".to_owned()),
                )
                .await;
            }
        }
    }
    let cancelled = cancel.is_cancelled() && !timed_out;
    let statuses = bootstrap_context.provider_statuses.lock().await;
    let partial = statuses.values().any(|status| {
        matches!(
            status.as_str(),
            "error" | "partial" | "unavailable" | "rateLimited" | "offline" | "timeout"
        )
    });
    drop(statuses);
    let status = if cancelled {
        "cancelled"
    } else if partial || timed_out {
        "partial"
    } else {
        "complete"
    };
    let mut complete = ReconEvent::new(&job_id, 0, "complete", "complete");
    complete.status = Some(status.to_owned());
    complete.message = Some(if cancelled {
        "Collection cancelled. Findings received before cancellation remain available.".to_owned()
    } else if timed_out {
        "Collection reached its 60-second deadline. Partial findings remain available.".to_owned()
    } else if partial {
        "Collection finished with one or more partial or unavailable sources.".to_owned()
    } else {
        "Passive collection finished.".to_owned()
    });
    emit(&bootstrap_context, complete).await;
}
