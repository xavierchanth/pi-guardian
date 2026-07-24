use std::{collections::BTreeMap, path::PathBuf};

use pi_tai_broker::{
    BrokerError, BrokerRecovery, BrokerSession, BrokerSessionId, ClientId, ForegroundState,
    OperationId, PiSessionBinding, RuntimeEventDisposition, RuntimeHealth, StopReason,
};
use pi_tai_event_store::{CoreAppendOutcome, CoreEvent, CoreTransaction, EventStore, OperationCommit, SessionProjection, StoreError, UsageEntry};
use pi_tai_host_protocol::{CURRENT_PROTOCOL_VERSION, HostEvent};
use pi_tai_runtime_protocol::{RuntimeEvent, SessionInfo};
use pi_tai_runtime_supervisor::{
    RuntimeProcessSpec, RuntimeSupervisor, RuntimeWorkerHandle, SupervisorError, SupervisorNotice,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{broadcast, mpsc, oneshot};

#[derive(Debug, Clone)]
pub struct HostKernelConfig {
    pub runtime: RuntimeProcessSpec,
    pub agent_dir: PathBuf,
    pub session_dir: PathBuf,
    pub database_path: PathBuf,
    pub faux: bool,
}

#[derive(Debug, Clone)]
pub struct CreateSession {
    pub client_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone)]
pub struct PromptSession {
    pub client_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub expected_revision: u64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct CancelSession {
    pub client_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RuntimeSnapshot {
    Unloaded,
    Starting { generation: u64 },
    Ready { generation: u64 },
    Interrupted { generation: u64 },
    Failed { generation: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ForegroundSnapshot {
    Idle {
        last_stop_reason: Option<String>,
    },
    Running {
        operation_id: String,
    },
    RequiresAction {
        operation_id: String,
        interaction_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionSnapshot {
    pub session_id: String,
    pub session_file: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: String,
    pub revision: u64,
    pub runtime_generation: u64,
    pub runtime: RuntimeSnapshot,
    pub foreground: ForegroundSnapshot,
    pub pi_session: Option<PiSessionSnapshot>,
    pub attachment_count: usize,
    pub active_client_id: Option<String>,
    pub control_epoch: u64,
}

#[derive(Clone)]
pub struct HostKernel {
    commands: mpsc::Sender<KernelCommand>,
    events: broadcast::Sender<HostEvent>,
}

impl HostKernel {
    pub fn start(config: HostKernelConfig) -> Result<Self, HostKernelError> {
        let store = EventStore::open(&config.database_path)?;
        let (commands, receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(1_024);
        tokio::spawn(run_actor(
            config,
            store,
            receiver,
            commands.clone(),
            events.clone(),
        ));
        Ok(Self { commands, events })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HostEvent> {
        self.events.subscribe()
    }

    pub async fn create_session(
        &self,
        request: CreateSession,
    ) -> Result<SessionSnapshot, HostKernelError> {
        self.request(|reply| KernelCommand::Create { request, reply })
            .await
    }

    pub async fn prompt(&self, request: PromptSession) -> Result<SessionSnapshot, HostKernelError> {
        self.request(|reply| KernelCommand::Prompt { request, reply })
            .await
    }

    pub async fn cancel(&self, request: CancelSession) -> Result<SessionSnapshot, HostKernelError> {
        self.request(|reply| KernelCommand::Cancel { request, reply })
            .await
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionSnapshot>, HostKernelError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(KernelCommand::List { reply })
            .await
            .map_err(|_| HostKernelError::Unavailable)?;
        response.await.map_err(|_| HostKernelError::Unavailable)?
    }

    pub async fn attach(
        &self,
        client_id: String,
        session_id: String,
    ) -> Result<SessionSnapshot, HostKernelError> {
        self.request(|reply| KernelCommand::Attach {
            client_id,
            session_id,
            reply,
        })
        .await
    }

    pub async fn detach(
        &self,
        client_id: String,
        session_id: String,
    ) -> Result<SessionSnapshot, HostKernelError> {
        self.request(|reply| KernelCommand::Detach {
            client_id,
            session_id,
            reply,
        })
        .await
    }

    pub async fn snapshot(&self, session_id: String) -> Result<SessionSnapshot, HostKernelError> {
        self.request(|reply| KernelCommand::Snapshot { session_id, reply })
            .await
    }

    pub async fn replay(
        &self,
        session_id: String,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<HostEvent>, HostKernelError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(KernelCommand::Replay {
                session_id,
                after_sequence,
                limit,
                reply,
            })
            .await
            .map_err(|_| HostKernelError::Unavailable)?;
        response.await.map_err(|_| HostKernelError::Unavailable)?
    }

    pub async fn shutdown(&self) -> Result<(), HostKernelError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(KernelCommand::Shutdown { reply })
            .await
            .map_err(|_| HostKernelError::Unavailable)?;
        response.await.map_err(|_| HostKernelError::Unavailable)?
    }

    async fn request(
        &self,
        command: impl FnOnce(oneshot::Sender<Result<SessionSnapshot, HostKernelError>>) -> KernelCommand,
    ) -> Result<SessionSnapshot, HostKernelError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(command(reply))
            .await
            .map_err(|_| HostKernelError::Unavailable)?;
        response.await.map_err(|_| HostKernelError::Unavailable)?
    }
}

enum KernelCommand {
    Create {
        request: CreateSession,
        reply: oneshot::Sender<Result<SessionSnapshot, HostKernelError>>,
    },
    Prompt {
        request: PromptSession,
        reply: oneshot::Sender<Result<SessionSnapshot, HostKernelError>>,
    },
    Cancel {
        request: CancelSession,
        reply: oneshot::Sender<Result<SessionSnapshot, HostKernelError>>,
    },
    List {
        reply: oneshot::Sender<Result<Vec<SessionSnapshot>, HostKernelError>>,
    },
    Attach {
        client_id: String,
        session_id: String,
        reply: oneshot::Sender<Result<SessionSnapshot, HostKernelError>>,
    },
    Detach {
        client_id: String,
        session_id: String,
        reply: oneshot::Sender<Result<SessionSnapshot, HostKernelError>>,
    },
    Snapshot {
        session_id: String,
        reply: oneshot::Sender<Result<SessionSnapshot, HostKernelError>>,
    },
    Replay {
        session_id: String,
        after_sequence: u64,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<HostEvent>, HostKernelError>>,
    },
    RuntimeNotice {
        session_id: String,
        notice: SupervisorNotice,
    },
    Shutdown {
        reply: oneshot::Sender<Result<(), HostKernelError>>,
    },
}

struct ManagedSession {
    state: BrokerSession,
    worker: Option<RuntimeWorkerHandle>,
    sequence: u64,
    cancelled_operations: Vec<OperationId>,
}

async fn run_actor(
    config: HostKernelConfig,
    mut store: EventStore,
    mut commands: mpsc::Receiver<KernelCommand>,
    sender: mpsc::Sender<KernelCommand>,
    events: broadcast::Sender<HostEvent>,
) {
    let mut sessions = match recover_sessions(&config, &sender, &events, &mut store).await {
        Ok(sessions) => sessions,
        Err(error) => {
            eprintln!("Pi-Tai Host recovery failed: {error}");
            return;
        }
    };
    while let Some(command) = commands.recv().await {
        match command {
            KernelCommand::Create { request, reply } => {
                let result = create_session(
                    &config,
                    &sender,
                    &events,
                    &mut store,
                    &mut sessions,
                    request,
                )
                .await;
                let _ = reply.send(result);
            }
            KernelCommand::Prompt { request, reply } => {
                let result = prompt_session(&events, &mut store, &mut sessions, request).await;
                let _ = reply.send(result);
            }
            KernelCommand::Cancel { request, reply } => {
                let result = cancel_session(&events, &mut store, &mut sessions, request).await;
                let _ = reply.send(result);
            }
            KernelCommand::List { reply } => {
                let result = Ok(sessions
                    .values()
                    .map(|session| snapshot(&session.state))
                    .collect());
                let _ = reply.send(result);
            }
            KernelCommand::Attach {
                client_id,
                session_id,
                reply,
            } => {
                let result = mutate_session(&mut sessions, &session_id, |session| {
                    session.state.attach(ClientId::parse(client_id)?);
                    emit(&events, &mut store, session, "client.attached", json!({}))?;
                    Ok(snapshot(&session.state))
                });
                let _ = reply.send(result);
            }
            KernelCommand::Detach {
                client_id,
                session_id,
                reply,
            } => {
                let result = mutate_session(&mut sessions, &session_id, |session| {
                    session.state.detach(&ClientId::parse(client_id)?);
                    emit(&events, &mut store, session, "client.detached", json!({}))?;
                    Ok(snapshot(&session.state))
                });
                let _ = reply.send(result);
            }
            KernelCommand::Snapshot { session_id, reply } => {
                let result = sessions
                    .get(&session_id)
                    .map(|session| snapshot(&session.state))
                    .ok_or(HostKernelError::UnknownSession(session_id));
                let _ = reply.send(result);
            }
            KernelCommand::Replay {
                session_id,
                after_sequence,
                limit,
                reply,
            } => {
                let result = if sessions.contains_key(&session_id) {
                    store
                        .events_after(&session_id, after_sequence, limit)
                        .map_err(HostKernelError::from)
                } else {
                    Err(HostKernelError::UnknownSession(session_id))
                };
                let _ = reply.send(result);
            }
            KernelCommand::RuntimeNotice { session_id, notice } => {
                if let Some(session) = sessions.get_mut(&session_id) {
                    let _ = handle_runtime_notice(&events, &mut store, session, notice).await;
                }
            }
            KernelCommand::Shutdown { reply } => {
                let mut result = Ok(());
                for session in sessions.values() {
                    let Some(worker) = &session.worker else {
                        continue;
                    };
                    if let Err(error) = worker.shutdown().await {
                        result = Err(error.into());
                    }
                }
                let _ = reply.send(result);
                return;
            }
        }
    }
}

async fn recover_sessions(
    config: &HostKernelConfig,
    actor: &mpsc::Sender<KernelCommand>,
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
) -> Result<BTreeMap<String, ManagedSession>, HostKernelError> {
    let mut sessions = BTreeMap::new();
    for projection in store.list_projections()? {
        let persisted: SessionSnapshot = serde_json::from_value(projection.snapshot)?;
        if persisted.session_id != projection.session_id
            || persisted.revision != projection.revision
            || persisted.runtime_generation != projection.runtime_generation
        {
            return Err(HostKernelError::InvalidProjection(projection.session_id));
        }
        let binding = persisted
            .pi_session
            .ok_or_else(|| HostKernelError::InvalidProjection(persisted.session_id.clone()))?;
        let interrupted = !matches!(persisted.foreground, ForegroundSnapshot::Idle { .. });
        let last_stop_reason = match persisted.foreground {
            ForegroundSnapshot::Idle { last_stop_reason } => last_stop_reason
                .as_deref()
                .map(parse_stop_reason)
                .transpose()?,
            ForegroundSnapshot::Running { .. } | ForegroundSnapshot::RequiresAction { .. } => None,
        };
        let mut state = BrokerSession::recover(BrokerRecovery {
            id: BrokerSessionId::parse(persisted.session_id.clone())?,
            revision: persisted.revision,
            runtime_generation: persisted.runtime_generation,
            pi_session: PiSessionBinding::new(
                binding.session_id,
                binding.session_file.clone(),
                binding.cwd,
            )?,
            interrupted_foreground: interrupted,
            last_stop_reason,
            active_client: persisted
                .active_client_id
                .map(ClientId::parse)
                .transpose()?,
            control_epoch: persisted.control_epoch,
        })?;
        let generation = state.begin_runtime_start()?;
        let started = RuntimeSupervisor::spawn(
            config.runtime.clone(),
            format!("runtime-{}", persisted.session_id),
            generation,
        )
        .await?;
        forward_notices(
            actor,
            persisted.session_id.clone(),
            started.handle.subscribe(),
        );
        let response = started
            .handle
            .request(
                "session.open",
                json!({
                    "sessionFile": binding.session_file,
                    "rootSessionId": persisted.session_id,
                    "runtimeGeneration": generation,
                    "agentDir": config.agent_dir,
                    "sessionDir": config.session_dir,
                    "faux": config.faux,
                }),
            )
            .await?;
        let info = decode_runtime_result::<SessionInfo>(response)?;
        state.mark_runtime_ready(
            generation,
            PiSessionBinding::new(info.session_id, info.session_file, info.cwd)?,
        )?;
        let mut managed = ManagedSession {
            state,
            worker: Some(started.handle),
            sequence: store.last_sequence(&persisted.session_id)?,
            cancelled_operations: Vec::new(),
        };
        emit(events, store, &mut managed, "runtime.recovered", json!({}))?;
        sessions.insert(persisted.session_id, managed);
    }
    Ok(sessions)
}

fn forward_notices(
    actor: &mpsc::Sender<KernelCommand>,
    session_id: String,
    mut notices: broadcast::Receiver<SupervisorNotice>,
) {
    let notice_sender = actor.clone();
    tokio::spawn(async move {
        loop {
            match notices.recv().await {
                Ok(notice) => {
                    if notice_sender
                        .send(KernelCommand::RuntimeNotice {
                            session_id: session_id.clone(),
                            notice,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

async fn create_session(
    config: &HostKernelConfig,
    actor: &mpsc::Sender<KernelCommand>,
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    sessions: &mut BTreeMap<String, ManagedSession>,
    request: CreateSession,
) -> Result<SessionSnapshot, HostKernelError> {
    if request.cwd.trim().is_empty() {
        return Err(HostKernelError::InvalidRequest("cwd must not be empty"));
    }
    std::fs::create_dir_all(&config.agent_dir)?;
    std::fs::create_dir_all(&config.session_dir)?;
    let session_id = BrokerSessionId::new();
    let session_key = session_id.as_str().to_owned();
    let mut state = BrokerSession::new(session_id);
    state.attach(ClientId::parse(request.client_id)?);
    let generation = state.begin_runtime_start()?;
    let started = RuntimeSupervisor::spawn(
        config.runtime.clone(),
        format!("runtime-{session_key}"),
        generation,
    )
    .await?;
    forward_notices(actor, session_key.clone(), started.handle.subscribe());
    let response = started
        .handle
        .request(
            "session.create",
            json!({
                "cwd": request.cwd,
                "rootSessionId": session_key,
                "runtimeGeneration": generation,
                "agentDir": config.agent_dir,
                "sessionDir": config.session_dir,
                "faux": config.faux,
            }),
        )
        .await?;
    let info = decode_runtime_result::<SessionInfo>(response)?;
    state.mark_runtime_ready(
        generation,
        PiSessionBinding::new(info.session_id, info.session_file, info.cwd)?,
    )?;
    let mut managed = ManagedSession {
        state,
        worker: Some(started.handle),
        sequence: 0,
        cancelled_operations: Vec::new(),
    };
    let created_payload = serde_json::to_value(snapshot(&managed.state))?;
    emit(
        events,
        store,
        &mut managed,
        "session.created",
        created_payload,
    )?;
    let result = snapshot(&managed.state);
    sessions.insert(session_key, managed);
    Ok(result)
}

async fn prompt_session(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    sessions: &mut BTreeMap<String, ManagedSession>,
    request: PromptSession,
) -> Result<SessionSnapshot, HostKernelError> {
    if request.text.trim().is_empty() {
        return Err(HostKernelError::InvalidRequest("prompt must not be empty"));
    }
    if let Some(response) = duplicate_operation(
        store,
        &request.operation_id,
        &request.session_id,
        "session.prompt",
    )? {
        return Ok(response);
    }
    let session = sessions
        .get_mut(&request.session_id)
        .ok_or_else(|| HostKernelError::UnknownSession(request.session_id.clone()))?;
    let operation_id = OperationId::parse(request.operation_id)?;
    let client_id = ClientId::parse(request.client_id)?;
    let expected_revision = attach_for_command(
        &mut session.state,
        client_id.clone(),
        request.expected_revision,
    )?;
    session
        .state
        .accept_prompt(&client_id, expected_revision, operation_id.clone())?;
    let accepted = snapshot(&session.state);
    emit_operation(
        events,
        store,
        session,
        "user.message",
        json!({
            "messageId": format!("user-{}", operation_id.as_str()),
            "operationId": operation_id.as_str(),
            "content": request.text.clone(),
        }),
        OperationCommit {
            operation_id: operation_id.as_str().into(),
            session_id: request.session_id.clone(),
            kind: "session.prompt".into(),
            expected_revision: Some(request.expected_revision),
            response: serde_json::to_value(&accepted)?,
        },
    )?;
    emit(
        events,
        store,
        session,
        "foreground.running",
        json!({ "operationId": operation_id.as_str() }),
    )?;
    let worker = session
        .worker
        .as_ref()
        .ok_or(HostKernelError::RuntimeUnavailable)?;
    let response = worker
        .request(
            "session.prompt",
            json!({
                "turnId": operation_id.as_str(),
                "text": request.text,
            }),
        )
        .await?;
    if !response.ok {
        session.state.complete_foreground(
            session.state.runtime_generation(),
            &operation_id,
            StopReason::Failed,
        )?;
        return Err(HostKernelError::RuntimeRejected(
            response
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "prompt rejected".into()),
        ));
    }
    Ok(snapshot(&session.state))
}

async fn cancel_session(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    sessions: &mut BTreeMap<String, ManagedSession>,
    request: CancelSession,
) -> Result<SessionSnapshot, HostKernelError> {
    let session = sessions
        .get_mut(&request.session_id)
        .ok_or_else(|| HostKernelError::UnknownSession(request.session_id.clone()))?;
    let operation_id = OperationId::parse(request.operation_id)?;
    let client_id = ClientId::parse(request.client_id)?;
    let expected_revision = attach_for_command(
        &mut session.state,
        client_id.clone(),
        request.expected_revision,
    )?;
    session
        .state
        .accept_cancel(&client_id, expected_revision, &operation_id)?;
    session.cancelled_operations.push(operation_id.clone());
    emit(
        events,
        store,
        session,
        "foreground.cancelling",
        json!({ "operationId": operation_id.as_str() }),
    )?;
    let worker = session
        .worker
        .as_ref()
        .ok_or(HostKernelError::RuntimeUnavailable)?;
    let response = worker
        .request("session.cancel", json!({ "turnId": operation_id.as_str() }))
        .await?;
    if !response.ok {
        return Err(HostKernelError::RuntimeRejected(
            response
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "cancellation rejected".into()),
        ));
    }
    Ok(snapshot(&session.state))
}

async fn handle_runtime_notice(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    session: &mut ManagedSession,
    notice: SupervisorNotice,
) -> Result<(), HostKernelError> {
    match notice {
        SupervisorNotice::RuntimeEvent(event) => {
            handle_runtime_event(events, store, session, event).await?
        }
        SupervisorNotice::WorkerExited { .. } => {
            let generation = session.state.runtime_generation();
            if session
                .state
                .runtime_exited(generation, "worker exited")
                .is_ok()
            {
                emit(events, store, session, "runtime.interrupted", json!({}))?;
            }
        }
        SupervisorNotice::StaleRuntimeEvent { .. }
        | SupervisorNotice::WorkerDiagnostic(_)
        | SupervisorNotice::ProtocolFailure(_) => {}
    }
    Ok(())
}

async fn handle_runtime_event(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    session: &mut ManagedSession,
    event: RuntimeEvent,
) -> Result<(), HostKernelError> {
    if session.state.accept_runtime_event(event.runtime_generation)
        != RuntimeEventDisposition::Current
    {
        return Ok(());
    }
    if event.event == "host.service_request" {
        return handle_host_service_request(events, store, session, event).await;
    }
    let usage_changed = record_runtime_usage(store, session, &event)?;
    let mut payload = event.data;
    if let (Some(turn_id), Some(object)) = (event.turn_id.as_deref(), payload.as_object_mut()) {
        object
            .entry("operationId")
            .or_insert_with(|| Value::String(turn_id.into()));
    }
    if event.event == "session.idle" {
        let operation_id = event
            .turn_id
            .as_deref()
            .and_then(|turn_id| OperationId::parse(turn_id).ok());
        if let Some(operation_id) = operation_id {
            let reason = if session
                .cancelled_operations
                .iter()
                .any(|cancelled| cancelled == &operation_id)
            {
                StopReason::Cancelled
            } else {
                StopReason::Completed
            };
            session
                .state
                .complete_foreground(event.runtime_generation, &operation_id, reason)?;
            if let Some(object) = payload.as_object_mut() {
                object.insert("stopReason".into(), stop_reason_name(reason).into());
            }
        }
    }
    if event.event == "session.replaced" {
        let binding = serde_json::from_value::<SessionInfo>(payload.clone())
            .ok()
            .and_then(|info| {
                PiSessionBinding::new(info.session_id, info.session_file, info.cwd).ok()
            });
        if let Some(binding) = binding {
            session
                .state
                .replace_pi_session(event.runtime_generation, binding)?;
        }
    }
    emit(events, store, session, &event.event, payload)?;
    if usage_changed {
        let usage = store.usage_breakdown(session.state.id().as_str())?;
        emit(events, store, session, "usage.replaced", serde_json::to_value(usage)?)?;
    }
    Ok(())
}

fn record_runtime_usage(store: &EventStore, session: &ManagedSession, event: &RuntimeEvent) -> Result<bool, HostKernelError> {
    if event.event != "message.end" || event.data["role"] != "assistant" { return Ok(false); }
    let session_id = session.state.id().as_str();
    let cycle_id = event.turn_id.as_deref().unwrap_or("root-idle");
    let message_id = event.data["messageId"].as_str();
    let provider = event.data["provider"].as_str();
    let model = event.data["model"].as_str();
    let usage = event.data.get("usage").and_then(Value::as_object);
    if message_id.is_none() || provider.is_none() || model.is_none() || usage.is_none() {
        return store.record_usage_gap(
            &format!("usage-gap-{session_id}-{}", event.worker_sequence), session_id, session_id, cycle_id,
            if usage.is_none() { "missing_message_usage" } else { "missing_model_identity" },
            &OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()),
        ).map_err(HostKernelError::from);
    }
    let usage = usage.expect("checked");
    let amount = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let cost = usage.get("cost").and_then(Value::as_object);
    let cost_amount = |key: &str| cost.and_then(|value| value.get(key)).and_then(Value::as_f64).unwrap_or(0.0);
    let entry = UsageEntry {
        usage_event_id: format!("usage-{session_id}-{cycle_id}-{}", message_id.expect("checked")), session_id: session_id.into(), context_id: session_id.into(), cycle_id: cycle_id.into(), message_id: message_id.expect("checked").into(),
        provider: provider.expect("checked").into(), model: model.expect("checked").into(), role: "thinker".into(),
        input: amount("input"), output: amount("output"), cache_read: amount("cacheRead"), cache_write: amount("cacheWrite"),
        cost_input: cost_amount("input"), cost_output: cost_amount("output"), cost_cache_read: cost_amount("cacheRead"), cost_cache_write: cost_amount("cacheWrite"), cost_total: cost_amount("total"),
        recorded_at: OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()),
    };
    store.record_usage(&entry).map_err(HostKernelError::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostServiceRequestData {
    request_id: String,
    method: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreTransactionRequest {
    transaction_id: String,
    expected_revision: u64,
    events: Vec<CoreEvent>,
    state: Value,
    projection: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentLoadRequest { key: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentPutRequest {
    key: String,
    transaction_id: String,
    expected_revision: u64,
    value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryLeaseRequest {
    repository_id: String,
    root_session_id: Option<String>,
    runtime_generation: Option<u64>,
    operation_id: String,
    lease_id: Option<String>,
    reason: Option<String>,
    transaction_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionWorkspaceLoadRequest { workspace_id: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionWorkspacePutRequest {
    workspace_id: String,
    transaction_id: String,
    expected_revision: u64,
    value: Value,
}

async fn handle_host_service_request(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    session: &mut ManagedSession,
    event: RuntimeEvent,
) -> Result<(), HostKernelError> {
    let request = serde_json::from_value::<HostServiceRequestData>(event.data)
        .map_err(|_| HostKernelError::InvalidRequest("Host service request is invalid"))?;
    let aggregate_id = format!("session:{}:concurrency", session.state.id().as_str());
    let outcome: Result<Value, HostKernelError> = (|| {
        match request.method.as_str() {
            "core.load" => Ok(serde_json::to_value(store.load_core_aggregate(&aggregate_id)?)?),
            "core.transact" => {
                let input = serde_json::from_value::<CoreTransactionRequest>(request.params.clone())
                    .map_err(|_| HostKernelError::InvalidRequest("core.transact parameters are invalid"))?;
                let timestamp = OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into());
                let transaction = CoreTransaction {
                    transaction_id: input.transaction_id,
                    aggregate_id: aggregate_id.clone(),
                    expected_revision: input.expected_revision,
                    runtime_generation: event.runtime_generation,
                    timestamp,
                    events: input.events,
                    state: input.state,
                    projection: input.projection,
                };
                let appended = store.append_core_transaction(&transaction)?;
                let aggregate = match appended {
                    CoreAppendOutcome::Committed { aggregate } | CoreAppendOutcome::Duplicate { aggregate } => aggregate,
                };
                emit(events, store, session, "concurrency.replaced", json!({ "aggregateId": aggregate.aggregate_id, "revision": aggregate.revision, "runtimeGeneration": aggregate.runtime_generation, "projection": aggregate.projection, "updatedAt": aggregate.updated_at }))?;
                Ok(serde_json::to_value(aggregate)?)
            }
            "repository.enrollment.load" => {
                let input = serde_json::from_value::<EnrollmentLoadRequest>(request.params.clone())
                    .map_err(|_| HostKernelError::InvalidRequest("repository enrollment load parameters are invalid"))?;
                validate_repository_key(&input.key)?;
                Ok(serde_json::to_value(store.load_core_aggregate(&format!("repository:{}:enrollment", input.key))?)?)
            }
            "repository.enrollment.put" => {
                let input = serde_json::from_value::<EnrollmentPutRequest>(request.params.clone())
                    .map_err(|_| HostKernelError::InvalidRequest("repository enrollment put parameters are invalid"))?;
                validate_repository_key(&input.key)?;
                let enrollment_aggregate_id = format!("repository:{}:enrollment", input.key);
                let transaction = CoreTransaction {
                    transaction_id: input.transaction_id,
                    aggregate_id: enrollment_aggregate_id,
                    expected_revision: input.expected_revision,
                    runtime_generation: event.runtime_generation,
                    timestamp: OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()),
                    events: vec![CoreEvent { event_id: format!("enrollment-event-{}", request.request_id), event_type: "repository.enrollment_replaced".into(), payload: json!({ "phase": input.value.get("phase") }) }],
                    state: input.value.clone(),
                    projection: input.value,
                };
                let appended = store.append_core_transaction(&transaction)?;
                let aggregate = match appended { CoreAppendOutcome::Committed { aggregate } | CoreAppendOutcome::Duplicate { aggregate } => aggregate };
                Ok(serde_json::to_value(aggregate)?)
            }
            "repository.lease.acquire" => {
                let input = serde_json::from_value::<RepositoryLeaseRequest>(request.params.clone()).map_err(|_| HostKernelError::InvalidRequest("repository lease acquire parameters are invalid"))?;
                let aggregate_id = repository_lease_aggregate(&input.repository_id)?;
                let current = store.load_core_aggregate(&aggregate_id)?;
                if current.as_ref().is_some_and(|aggregate| aggregate.projection["phase"] != "available") { return Err(HostKernelError::RepositoryBusy(input.repository_id)); }
                let generation = current.as_ref().and_then(|aggregate| aggregate.projection["generation"].as_u64()).unwrap_or(0).checked_add(1).ok_or(HostKernelError::CounterOverflow("repository lease generation"))?;
                let lease = json!({
                    "phase": "leased", "repositoryId": input.repository_id, "generation": generation,
                    "leaseId": format!("repo-lease-{}", input.transaction_id),
                    "rootSessionId": input.root_session_id.ok_or(HostKernelError::InvalidRequest("rootSessionId is required"))?,
                    "runtimeGeneration": input.runtime_generation.ok_or(HostKernelError::InvalidRequest("runtimeGeneration is required"))?,
                    "operationId": input.operation_id, "acquiredAt": OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
                });
                let aggregate = replace_core_aggregate(store, aggregate_id, input.transaction_id, current.as_ref().map_or(0, |value| value.revision), event.runtime_generation, "repository.lease_acquired", lease.clone())?;
                let _ = aggregate;
                Ok(lease)
            }
            "repository.lease.release" | "repository.lease.interrupt" => {
                let input = serde_json::from_value::<RepositoryLeaseRequest>(request.params.clone()).map_err(|_| HostKernelError::InvalidRequest("repository lease completion parameters are invalid"))?;
                let aggregate_id = repository_lease_aggregate(&input.repository_id)?;
                let current = store.load_core_aggregate(&aggregate_id)?.ok_or_else(|| HostKernelError::RepositoryBusy(input.repository_id.clone()))?;
                if current.projection["phase"] != "leased" || current.projection["leaseId"].as_str() != input.lease_id.as_deref() || current.projection["operationId"].as_str() != Some(input.operation_id.as_str()) { return Err(HostKernelError::RepositoryLeaseMismatch); }
                let generation = current.projection["generation"].as_u64().ok_or(HostKernelError::RepositoryLeaseMismatch)?;
                let next = if request.method == "repository.lease.release" {
                    json!({ "phase": "available", "repositoryId": input.repository_id, "generation": generation })
                } else {
                    json!({ "phase": "interrupted", "repositoryId": input.repository_id, "generation": generation, "priorLeaseId": input.lease_id, "priorRootSessionId": current.projection["rootSessionId"], "priorRuntimeGeneration": current.projection["runtimeGeneration"], "operationId": input.operation_id, "reason": input.reason.unwrap_or_else(|| "runtime mutation interrupted".into()), "interruptedAt": OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()) })
                };
                let event_type = if request.method == "repository.lease.release" { "repository.lease_released" } else { "repository.lease_interrupted" };
                replace_core_aggregate(store, aggregate_id, input.transaction_id, current.revision, event.runtime_generation, event_type, next.clone())?;
                Ok(next)
            }
            "session.workspace.load" => {
                let input = serde_json::from_value::<SessionWorkspaceLoadRequest>(request.params.clone()).map_err(|_| HostKernelError::InvalidRequest("session workspace load parameters are invalid"))?;
                validate_semantic_id(&input.workspace_id)?;
                Ok(serde_json::to_value(store.load_core_aggregate(&format!("session:{}:workspace:{}", session.state.id().as_str(), input.workspace_id))?)?)
            }
            "session.workspace.put" => {
                let input = serde_json::from_value::<SessionWorkspacePutRequest>(request.params.clone()).map_err(|_| HostKernelError::InvalidRequest("session workspace put parameters are invalid"))?;
                validate_semantic_id(&input.workspace_id)?;
                let aggregate_id = format!("session:{}:workspace:{}", session.state.id().as_str(), input.workspace_id);
                let aggregate = replace_core_aggregate(store, aggregate_id, input.transaction_id, input.expected_revision, event.runtime_generation, "session.workspace_replaced", input.value)?;
                Ok(serde_json::to_value(aggregate)?)
            }
            _ => Err(HostKernelError::UnsupportedHostService(request.method.clone())),
        }
    })();
    let response_params = match outcome {
        Ok(result) => json!({ "requestId": request.request_id, "ok": true, "result": result }),
        Err(error) => json!({
            "requestId": request.request_id,
            "ok": false,
            "error": { "code": "host_service_error", "message": error.to_string(), "retryable": false }
        }),
    };
    let worker = session.worker.as_ref().ok_or(HostKernelError::RuntimeUnavailable)?;
    let response = worker.request("host.service_response", response_params).await?;
    if !response.ok {
        return Err(HostKernelError::RuntimeRejected(response.error.map(|error| error.message).unwrap_or_else(|| "Host service response was rejected".into())));
    }
    Ok(())
}

fn replace_core_aggregate(store: &mut EventStore, aggregate_id: String, transaction_id: String, expected_revision: u64, runtime_generation: u64, event_type: &str, projection: Value) -> Result<pi_tai_event_store::CoreAggregate, HostKernelError> {
    let transaction = CoreTransaction {
        transaction_id: transaction_id.clone(), aggregate_id, expected_revision, runtime_generation,
        timestamp: OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()),
        events: vec![CoreEvent { event_id: format!("event-{transaction_id}"), event_type: event_type.into(), payload: json!({ "phase": projection.get("phase") }) }], state: projection.clone(), projection,
    };
    Ok(match store.append_core_transaction(&transaction)? { CoreAppendOutcome::Committed { aggregate } | CoreAppendOutcome::Duplicate { aggregate } => aggregate })
}

fn repository_lease_aggregate(repository_id: &str) -> Result<String, HostKernelError> { validate_repository_key(repository_id)?; Ok(format!("repository:{repository_id}:mutation-lease")) }
fn validate_semantic_id(value: &str) -> Result<(), HostKernelError> { if value.is_empty() || value.len() > 128 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte)) { return Err(HostKernelError::InvalidRequest("semantic ID is invalid")); } Ok(()) }

fn validate_repository_key(value: &str) -> Result<(), HostKernelError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return Err(HostKernelError::InvalidRequest("repository enrollment key must be lowercase SHA-256"));
    }
    Ok(())
}

fn emit(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    session: &mut ManagedSession,
    event_type: &str,
    payload: Value,
) -> Result<(), HostKernelError> {
    persist_and_emit(events, store, session, event_type, payload, None)
}

fn emit_operation(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    session: &mut ManagedSession,
    event_type: &str,
    payload: Value,
    operation: OperationCommit,
) -> Result<(), HostKernelError> {
    persist_and_emit(events, store, session, event_type, payload, Some(operation))
}

fn persist_and_emit(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    session: &mut ManagedSession,
    event_type: &str,
    payload: Value,
    operation: Option<OperationCommit>,
) -> Result<(), HostKernelError> {
    let sequence = session
        .sequence
        .checked_add(1)
        .ok_or(HostKernelError::CounterOverflow("event sequence"))?;
    let event = HostEvent {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        session_id: session.state.id().as_str().into(),
        sequence,
        revision: session.state.revision(),
        runtime_generation: session.state.runtime_generation(),
        timestamp: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()),
        event_type: event_type.into(),
        payload,
    };
    let current = snapshot(&session.state);
    store.append(
        &SessionProjection {
            session_id: current.session_id.clone(),
            revision: current.revision,
            runtime_generation: current.runtime_generation,
            snapshot: serde_json::to_value(&current)?,
        },
        &event,
        operation.as_ref(),
    )?;
    session.sequence = sequence;
    let _ = events.send(event);
    Ok(())
}

fn snapshot(state: &BrokerSession) -> SessionSnapshot {
    SessionSnapshot {
        session_id: state.id().as_str().into(),
        revision: state.revision(),
        runtime_generation: state.runtime_generation(),
        runtime: match state.runtime_health() {
            RuntimeHealth::Unloaded => RuntimeSnapshot::Unloaded,
            RuntimeHealth::Starting { generation } => RuntimeSnapshot::Starting { generation },
            RuntimeHealth::Ready { generation } => RuntimeSnapshot::Ready { generation },
            RuntimeHealth::Interrupted { generation } => {
                RuntimeSnapshot::Interrupted { generation }
            }
            RuntimeHealth::Failed { generation } => RuntimeSnapshot::Failed { generation },
        },
        foreground: match state.foreground() {
            ForegroundState::Idle { last_stop_reason } => ForegroundSnapshot::Idle {
                last_stop_reason: last_stop_reason.map(stop_reason_name).map(str::to_owned),
            },
            ForegroundState::Running { operation_id } => ForegroundSnapshot::Running {
                operation_id: operation_id.as_str().into(),
            },
            ForegroundState::RequiresAction {
                operation_id,
                interaction_id,
            } => ForegroundSnapshot::RequiresAction {
                operation_id: operation_id.as_str().into(),
                interaction_id: interaction_id.as_str().into(),
            },
        },
        pi_session: state.pi_session().map(|binding| PiSessionSnapshot {
            session_id: binding.pi_session_id().into(),
            session_file: binding.session_file().into(),
            cwd: binding.cwd().into(),
        }),
        attachment_count: state.attachment_count(),
        active_client_id: state.active_client().map(|client| client.as_str().into()),
        control_epoch: state.control_epoch(),
    }
}

fn parse_stop_reason(value: &str) -> Result<StopReason, HostKernelError> {
    match value {
        "completed" => Ok(StopReason::Completed),
        "cancelled" => Ok(StopReason::Cancelled),
        "interrupted" => Ok(StopReason::Interrupted),
        "failed" => Ok(StopReason::Failed),
        _ => Err(HostKernelError::InvalidStopReason(value.into())),
    }
}

fn stop_reason_name(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Completed => "completed",
        StopReason::Cancelled => "cancelled",
        StopReason::Interrupted => "interrupted",
        StopReason::Failed => "failed",
    }
}

fn attach_for_command(
    state: &mut BrokerSession,
    client_id: ClientId,
    expected_revision: u64,
) -> Result<u64, HostKernelError> {
    if state.is_attached(&client_id) {
        return Ok(expected_revision);
    }
    if state.revision() != expected_revision {
        return Err(BrokerError::RevisionConflict {
            expected: expected_revision,
            actual: state.revision(),
        }
        .into());
    }
    state.attach(client_id);
    Ok(state.revision())
}

fn mutate_session(
    sessions: &mut BTreeMap<String, ManagedSession>,
    session_id: &str,
    mutation: impl FnOnce(&mut ManagedSession) -> Result<SessionSnapshot, HostKernelError>,
) -> Result<SessionSnapshot, HostKernelError> {
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| HostKernelError::UnknownSession(session_id.into()))?;
    mutation(session)
}

fn duplicate_operation(
    store: &EventStore,
    operation_id: &str,
    session_id: &str,
    kind: &str,
) -> Result<Option<SessionSnapshot>, HostKernelError> {
    let Some(operation) = store.operation(operation_id)? else {
        return Ok(None);
    };
    if operation.session_id != session_id || operation.kind != kind {
        return Err(HostKernelError::OperationCollision(operation_id.into()));
    }
    serde_json::from_value(operation.response)
        .map(Some)
        .map_err(HostKernelError::Json)
}

fn decode_runtime_result<T: serde::de::DeserializeOwned>(
    response: pi_tai_runtime_protocol::RuntimeResponse,
) -> Result<T, HostKernelError> {
    if !response.ok {
        return Err(HostKernelError::RuntimeRejected(
            response
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "runtime command rejected".into()),
        ));
    }
    serde_json::from_value(
        response
            .result
            .ok_or(HostKernelError::MissingRuntimeResult)?,
    )
    .map_err(HostKernelError::Json)
}

#[derive(Debug, Error)]
pub enum HostKernelError {
    #[error("Host kernel is unavailable")]
    Unavailable,
    #[error("unknown broker session: {0}")]
    UnknownSession(String),
    #[error("invalid Host request: {0}")]
    InvalidRequest(&'static str),
    #[error("unsupported runtime Host service: {0}")]
    UnsupportedHostService(String),
    #[error("repository is busy or requires recovery: {0}")]
    RepositoryBusy(String),
    #[error("repository mutation lease does not match the active operation")]
    RepositoryLeaseMismatch,
    #[error(transparent)]
    Broker(#[from] BrokerError),
    #[error(transparent)]
    Supervisor(#[from] SupervisorError),
    #[error("runtime rejected command: {0}")]
    RuntimeRejected(String),
    #[error("runtime command returned no result")]
    MissingRuntimeResult,
    #[error("runtime is not loaded for this broker session")]
    RuntimeUnavailable,
    #[error("invalid persisted session projection: {0}")]
    InvalidProjection(String),
    #[error("invalid persisted stop reason: {0}")]
    InvalidStopReason(String),
    #[error("{0} counter overflow")]
    CounterOverflow(&'static str),
    #[error("operation ID was reused for another Host command: {0}")]
    OperationCollision(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
