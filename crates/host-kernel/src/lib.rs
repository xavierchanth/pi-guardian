use std::{collections::BTreeMap, path::PathBuf};

use pi_tai_broker::{
    BrokerError, BrokerSession, BrokerSessionId, ClientId, ForegroundState, OperationId,
    PiSessionBinding, RuntimeEventDisposition, RuntimeHealth, StopReason,
};
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
    pub fn start(config: HostKernelConfig) -> Self {
        let (commands, receiver) = mpsc::channel(256);
        let (events, _) = broadcast::channel(1_024);
        tokio::spawn(run_actor(
            config,
            receiver,
            commands.clone(),
            events.clone(),
        ));
        Self { commands, events }
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
    worker: RuntimeWorkerHandle,
    sequence: u64,
    cancelled_operations: Vec<OperationId>,
}

async fn run_actor(
    config: HostKernelConfig,
    mut commands: mpsc::Receiver<KernelCommand>,
    sender: mpsc::Sender<KernelCommand>,
    events: broadcast::Sender<HostEvent>,
) {
    let mut sessions = BTreeMap::<String, ManagedSession>::new();
    while let Some(command) = commands.recv().await {
        match command {
            KernelCommand::Create { request, reply } => {
                let result =
                    create_session(&config, &sender, &events, &mut sessions, request).await;
                let _ = reply.send(result);
            }
            KernelCommand::Prompt { request, reply } => {
                let result = prompt_session(&events, &mut sessions, request).await;
                let _ = reply.send(result);
            }
            KernelCommand::Cancel { request, reply } => {
                let result = cancel_session(&events, &mut sessions, request).await;
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
            KernelCommand::RuntimeNotice { session_id, notice } => {
                if let Some(session) = sessions.get_mut(&session_id) {
                    handle_runtime_notice(&events, session, notice);
                }
            }
            KernelCommand::Shutdown { reply } => {
                let mut result = Ok(());
                for session in sessions.values() {
                    if let Err(error) = session.worker.shutdown().await {
                        result = Err(error.into());
                    }
                }
                let _ = reply.send(result);
                return;
            }
        }
    }
}

async fn create_session(
    config: &HostKernelConfig,
    actor: &mpsc::Sender<KernelCommand>,
    events: &broadcast::Sender<HostEvent>,
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
    let mut notices = started.handle.subscribe();
    let notice_sender = actor.clone();
    let notice_session_id = session_key.clone();
    tokio::spawn(async move {
        loop {
            match notices.recv().await {
                Ok(notice) => {
                    if notice_sender
                        .send(KernelCommand::RuntimeNotice {
                            session_id: notice_session_id.clone(),
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
        worker: started.handle,
        sequence: 0,
        cancelled_operations: Vec::new(),
    };
    let created_payload = serde_json::to_value(snapshot(&managed.state))?;
    emit(events, &mut managed, "session.created", created_payload);
    let result = snapshot(&managed.state);
    sessions.insert(session_key, managed);
    Ok(result)
}

async fn prompt_session(
    events: &broadcast::Sender<HostEvent>,
    sessions: &mut BTreeMap<String, ManagedSession>,
    request: PromptSession,
) -> Result<SessionSnapshot, HostKernelError> {
    if request.text.trim().is_empty() {
        return Err(HostKernelError::InvalidRequest("prompt must not be empty"));
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
    emit(
        events,
        session,
        "foreground.running",
        json!({ "operationId": operation_id.as_str() }),
    );
    let response = session
        .worker
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
        session,
        "foreground.cancelling",
        json!({ "operationId": operation_id.as_str() }),
    );
    let response = session
        .worker
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
    session: &mut ManagedSession,
    notice: SupervisorNotice,
) {
    match notice {
        SupervisorNotice::RuntimeEvent(event) => handle_runtime_event(events, session, event),
        SupervisorNotice::WorkerExited { .. } => {
            let generation = session.state.runtime_generation();
            if session
                .state
                .runtime_exited(generation, "worker exited")
                .is_ok()
            {
                emit(events, session, "runtime.interrupted", json!({}));
            }
        }
        SupervisorNotice::StaleRuntimeEvent { .. }
        | SupervisorNotice::WorkerDiagnostic(_)
        | SupervisorNotice::ProtocolFailure(_) => {}
    }
}

fn handle_runtime_event(
    events: &broadcast::Sender<HostEvent>,
    session: &mut ManagedSession,
    event: RuntimeEvent,
) {
    if session.state.accept_runtime_event(event.runtime_generation)
        != RuntimeEventDisposition::Current
    {
        return;
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
            let _ =
                session
                    .state
                    .complete_foreground(event.runtime_generation, &operation_id, reason);
        }
    }
    if event.event == "session.replaced" {
        let binding = serde_json::from_value::<SessionInfo>(event.data.clone())
            .ok()
            .and_then(|info| {
                PiSessionBinding::new(info.session_id, info.session_file, info.cwd).ok()
            });
        if let Some(binding) = binding {
            let _ = session
                .state
                .replace_pi_session(event.runtime_generation, binding);
        }
    }
    emit(events, session, &event.event, event.data);
}

fn emit(
    events: &broadcast::Sender<HostEvent>,
    session: &mut ManagedSession,
    event_type: &str,
    payload: Value,
) {
    session.sequence = session.sequence.saturating_add(1);
    let _ = events.send(HostEvent {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        session_id: session.state.id().as_str().into(),
        sequence: session.sequence,
        revision: session.state.revision(),
        runtime_generation: session.state.runtime_generation(),
        timestamp: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into()),
        event_type: event_type.into(),
        payload,
    });
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
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
