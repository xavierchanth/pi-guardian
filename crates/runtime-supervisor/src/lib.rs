use std::{collections::BTreeMap, path::PathBuf, process::ExitStatus, time::Duration};

use pi_tai_runtime_protocol::{
    CURRENT_RUNTIME_PROTOCOL_VERSION, CommandFrameKind, ProtocolRange, RuntimeCommand,
    RuntimeEvent, RuntimeInitializeParams, RuntimeInitializeResult, RuntimeResponse,
};
use serde_json::Value;
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStderr, ChildStdout, Command},
    sync::{broadcast, mpsc, oneshot},
};
use uuid::Uuid;

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct RuntimeProcessSpec {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
}

pub struct RuntimeSupervisor;

pub struct StartedRuntime {
    pub handle: RuntimeWorkerHandle,
    pub initialize: RuntimeInitializeResult,
}

impl RuntimeSupervisor {
    pub async fn spawn(
        spec: RuntimeProcessSpec,
        worker_id: impl Into<String>,
        runtime_generation: u64,
    ) -> Result<StartedRuntime, SupervisorError> {
        if runtime_generation == 0 {
            return Err(SupervisorError::InvalidGeneration);
        }
        let worker_id = worker_id.into();
        if worker_id.trim().is_empty() {
            return Err(SupervisorError::InvalidWorkerId);
        }

        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.args)
            .envs(&spec.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        let mut child = command
            .spawn()
            .map_err(|error| SupervisorError::Spawn(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or(SupervisorError::MissingProcessPipe("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(SupervisorError::MissingProcessPipe("stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(SupervisorError::MissingProcessPipe("stderr"))?;

        let (control_tx, control_rx) = mpsc::channel(64);
        let (reader_tx, reader_rx) = mpsc::channel(128);
        let (notice_tx, _) = broadcast::channel(256);
        tokio::spawn(read_stdout(stdout, reader_tx));
        tokio::spawn(read_stderr(stderr, notice_tx.clone()));
        tokio::spawn(run_actor(
            child,
            stdin,
            runtime_generation,
            control_rx,
            reader_rx,
            notice_tx.clone(),
        ));

        let handle = RuntimeWorkerHandle {
            control: control_tx,
            notices: notice_tx,
            generation: runtime_generation,
        };
        let initialize_response = tokio::time::timeout(
            INITIALIZE_TIMEOUT,
            handle.request(
                "runtime.initialize",
                serde_json::to_value(RuntimeInitializeParams {
                    protocol: ProtocolRange {
                        min_version: CURRENT_RUNTIME_PROTOCOL_VERSION,
                        max_version: CURRENT_RUNTIME_PROTOCOL_VERSION,
                    },
                    worker_id: worker_id.clone(),
                    runtime_generation,
                })
                .map_err(|error| SupervisorError::Encode(error.to_string()))?,
            ),
        )
        .await
        .map_err(|_| SupervisorError::InitializeTimeout)??;
        if !initialize_response.ok {
            return Err(SupervisorError::RuntimeRejected(
                initialize_response
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "runtime initialization failed".into()),
            ));
        }
        let initialize: RuntimeInitializeResult = serde_json::from_value(
            initialize_response
                .result
                .ok_or(SupervisorError::MissingInitializeResult)?,
        )
        .map_err(|error| SupervisorError::Decode(error.to_string()))?;
        if initialize.worker_id != worker_id || initialize.runtime_generation != runtime_generation
        {
            return Err(SupervisorError::InitializeIdentityMismatch);
        }

        Ok(StartedRuntime { handle, initialize })
    }
}

#[derive(Clone)]
pub struct RuntimeWorkerHandle {
    control: mpsc::Sender<Control>,
    notices: broadcast::Sender<SupervisorNotice>,
    generation: u64,
}

impl RuntimeWorkerHandle {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SupervisorNotice> {
        self.notices.subscribe()
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<RuntimeResponse, SupervisorError> {
        let id = Uuid::now_v7().to_string();
        let command = RuntimeCommand {
            protocol_version: CURRENT_RUNTIME_PROTOCOL_VERSION,
            kind: CommandFrameKind::Command,
            id,
            method: method.into(),
            params,
        };
        let (response_tx, response_rx) = oneshot::channel();
        self.control
            .send(Control::Request {
                command,
                response: response_tx,
            })
            .await
            .map_err(|_| SupervisorError::WorkerUnavailable)?;
        response_rx
            .await
            .map_err(|_| SupervisorError::WorkerUnavailable)?
    }

    pub async fn shutdown(&self) -> Result<(), SupervisorError> {
        let response = self
            .request("runtime.shutdown", serde_json::json!({}))
            .await?;
        if response.ok {
            Ok(())
        } else {
            Err(SupervisorError::RuntimeRejected(
                response
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "runtime shutdown failed".into()),
            ))
        }
    }
}

#[derive(Debug, Clone)]
pub enum SupervisorNotice {
    RuntimeEvent(RuntimeEvent),
    StaleRuntimeEvent {
        received: u64,
        expected: u64,
        event: String,
    },
    WorkerDiagnostic(String),
    ProtocolFailure(String),
    WorkerExited {
        success: bool,
        code: Option<i32>,
    },
}

enum Control {
    Request {
        command: RuntimeCommand,
        response: oneshot::Sender<Result<RuntimeResponse, SupervisorError>>,
    },
}

enum ReaderMessage {
    Response(RuntimeResponse),
    Event(RuntimeEvent),
    Failure(String),
    Closed,
}

async fn run_actor(
    mut child: tokio::process::Child,
    mut stdin: tokio::process::ChildStdin,
    expected_generation: u64,
    mut controls: mpsc::Receiver<Control>,
    mut frames: mpsc::Receiver<ReaderMessage>,
    notices: broadcast::Sender<SupervisorNotice>,
) {
    let mut pending =
        BTreeMap::<String, oneshot::Sender<Result<RuntimeResponse, SupervisorError>>>::new();
    let mut reader_closed = false;

    loop {
        tokio::select! {
            control = controls.recv() => {
                let Some(Control::Request { command, response }) = control else {
                    let _ = child.start_kill();
                    break;
                };
                let id = command.id.clone();
                match encode_command(&command) {
                    Ok(encoded) => {
                        let write_result = async {
                            stdin.write_all(encoded.as_bytes()).await?;
                            stdin.write_all(b"\n").await?;
                            stdin.flush().await
                        }
                        .await;
                        if let Err(error) = write_result {
                            let _ = response.send(Err(SupervisorError::Write(error.to_string())));
                            let _ = child.start_kill();
                        } else {
                            pending.insert(id, response);
                        }
                    }
                    Err(error) => {
                        let _ = response.send(Err(error));
                    }
                }
            }
            frame = frames.recv(), if !reader_closed => {
                match frame {
                    Some(ReaderMessage::Response(response)) => {
                        if let Some(waiter) = pending.remove(&response.id) {
                            let _ = waiter.send(Ok(response));
                        } else {
                            let _ = notices.send(SupervisorNotice::ProtocolFailure(
                                "runtime returned a response for an unknown command".into(),
                            ));
                        }
                    }
                    Some(ReaderMessage::Event(event)) if event.runtime_generation == expected_generation => {
                        let _ = notices.send(SupervisorNotice::RuntimeEvent(event));
                    }
                    Some(ReaderMessage::Event(event)) => {
                        let _ = notices.send(SupervisorNotice::StaleRuntimeEvent {
                            received: event.runtime_generation,
                            expected: expected_generation,
                            event: event.event,
                        });
                    }
                    Some(ReaderMessage::Failure(message)) => {
                        let _ = notices.send(SupervisorNotice::ProtocolFailure(message));
                        let _ = child.start_kill();
                        reader_closed = true;
                    }
                    Some(ReaderMessage::Closed) | None => {
                        reader_closed = true;
                    }
                }
            }
            status = child.wait() => {
                let status = status.ok();
                fail_pending(&mut pending, "runtime worker exited");
                let _ = notices.send(exit_notice(status.as_ref()));
                break;
            }
        }
    }
}

fn encode_command(command: &RuntimeCommand) -> Result<String, SupervisorError> {
    serde_json::to_string(command).map_err(|error| SupervisorError::Encode(error.to_string()))
}

fn fail_pending(
    pending: &mut BTreeMap<String, oneshot::Sender<Result<RuntimeResponse, SupervisorError>>>,
    message: &str,
) {
    for (_, waiter) in std::mem::take(pending) {
        let _ = waiter.send(Err(SupervisorError::ProcessExited(message.into())));
    }
}

fn exit_notice(status: Option<&ExitStatus>) -> SupervisorNotice {
    SupervisorNotice::WorkerExited {
        success: status.is_some_and(ExitStatus::success),
        code: status.and_then(ExitStatus::code),
    }
}

async fn read_stdout(stdout: ChildStdout, sender: mpsc::Sender<ReaderMessage>) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => match decode_frame(&line) {
                Ok(frame) => {
                    if sender.send(frame).await.is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(ReaderMessage::Failure(error.to_string())).await;
                    return;
                }
            },
            Ok(None) => {
                let _ = sender.send(ReaderMessage::Closed).await;
                return;
            }
            Err(error) => {
                let _ = sender.send(ReaderMessage::Failure(error.to_string())).await;
                return;
            }
        }
    }
}

async fn read_stderr(stderr: ChildStderr, notices: broadcast::Sender<SupervisorNotice>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let bounded = line.chars().take(2_000).collect::<String>();
        let _ = notices.send(SupervisorNotice::WorkerDiagnostic(bounded));
    }
}

fn decode_frame(line: &str) -> Result<ReaderMessage, SupervisorError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|_| SupervisorError::Decode("runtime stdout contained invalid JSON".into()))?;
    match value.get("kind").and_then(Value::as_str) {
        Some("response") => serde_json::from_value(value)
            .map(ReaderMessage::Response)
            .map_err(|error| SupervisorError::Decode(error.to_string())),
        Some("event") => serde_json::from_value(value)
            .map(ReaderMessage::Event)
            .map_err(|error| SupervisorError::Decode(error.to_string())),
        _ => Err(SupervisorError::Decode(
            "runtime stdout contained an unsupported frame".into(),
        )),
    }
}

#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("runtime generation must be positive")]
    InvalidGeneration,
    #[error("worker ID must not be empty")]
    InvalidWorkerId,
    #[error("failed to spawn runtime worker: {0}")]
    Spawn(String),
    #[error("runtime worker did not expose {0}")]
    MissingProcessPipe(&'static str),
    #[error("failed to encode runtime frame: {0}")]
    Encode(String),
    #[error("failed to decode runtime frame: {0}")]
    Decode(String),
    #[error("failed to write runtime frame: {0}")]
    Write(String),
    #[error("runtime worker is unavailable")]
    WorkerUnavailable,
    #[error("runtime worker exited: {0}")]
    ProcessExited(String),
    #[error("runtime initialization timed out")]
    InitializeTimeout,
    #[error("runtime initialization returned no result")]
    MissingInitializeResult,
    #[error("runtime initialization identity did not match the launched worker")]
    InitializeIdentityMismatch,
    #[error("runtime rejected command: {0}")]
    RuntimeRejected(String),
}
