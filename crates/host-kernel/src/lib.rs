use std::{collections::BTreeMap, path::PathBuf};

use pi_tai_broker::{
    BrokerError, BrokerRecovery, BrokerSession, BrokerSessionId, ClientId, ForegroundState,
    OperationId, PiSessionBinding, RuntimeEventDisposition, RuntimeHealth, StopReason,
};
use pi_tai_event_store::{EventStore, OperationCommit, SessionProjection, StoreError};
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
                    let _ = handle_runtime_notice(&events, &mut store, session, notice);
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

fn handle_runtime_notice(
    events: &broadcast::Sender<HostEvent>,
    store: &mut EventStore,
    session: &mut ManagedSession,
    notice: SupervisorNotice,
) -> Result<(), HostKernelError> {
    match notice {
        SupervisorNotice::RuntimeEvent(event) => {
            handle_runtime_event(events, store, session, event)?
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

fn handle_runtime_event(
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
    emit(events, store, session, &event.event, payload)
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
