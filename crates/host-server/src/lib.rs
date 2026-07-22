#![cfg(unix)]

use std::collections::BTreeSet;

use pi_tai_host_kernel::{
    CancelSession, CreateSession, HostKernel, HostKernelError, PromptSession, SessionSnapshot,
};
use pi_tai_host_protocol::{
    CURRENT_PROTOCOL_VERSION, ClientFrame, HostCommand, HostProtocolError, HostResponse,
    HostResponseOutcome, ServerFrame,
};
use pi_tai_local_ipc::{IpcConnection, IpcError, IpcListener};
use serde::Deserialize;
use serde_json::{Value, json};

pub struct HostIpcServer {
    listener: IpcListener,
    kernel: HostKernel,
}

impl HostIpcServer {
    pub fn new(listener: IpcListener, kernel: HostKernel) -> Self {
        Self { listener, kernel }
    }

    pub async fn run(self) -> Result<(), IpcError> {
        loop {
            match self.listener.accept().await {
                Ok(connection) => {
                    let kernel = self.kernel.clone();
                    tokio::spawn(async move {
                        let _ = serve_connection(kernel, connection).await;
                    });
                }
                Err(IpcError::AuthenticationFailed | IpcError::ProtocolMismatch) => continue,
                Err(error) => return Err(error),
            }
        }
    }
}

async fn serve_connection(
    kernel: HostKernel,
    mut connection: IpcConnection,
) -> Result<(), IpcError> {
    let mut attachments = BTreeSet::<(String, String)>::new();
    loop {
        let frame = match connection.read::<ClientFrame>().await {
            Ok(frame) => frame,
            Err(IpcError::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::UnexpectedEof
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::BrokenPipe
                ) =>
            {
                detach_all(&kernel, attachments).await;
                return Ok(());
            }
            Err(error) => {
                detach_all(&kernel, attachments).await;
                return Err(error);
            }
        };
        let ClientFrame::Command { command } = frame else {
            connection
                .write(&ServerFrame::Error {
                    error: protocol_error(
                        "already_authenticated",
                        "Connection is already authenticated.",
                    ),
                })
                .await?;
            continue;
        };
        let request_id = command.request_id.clone();
        match execute_command(&kernel, &command).await {
            Ok(CommandResult::Reply { result, attachment }) => {
                if let Some(attachment) = attachment {
                    attachments.insert(attachment);
                }
                connection
                    .write(&success_response(request_id, result))
                    .await?;
            }
            Ok(CommandResult::Observe {
                snapshot,
                attachment,
            }) => {
                attachments.insert(attachment.clone());
                let mut events = kernel.subscribe();
                connection
                    .write(&success_response(
                        request_id,
                        serde_json::to_value(snapshot)
                            .map_err(|error| IpcError::InvalidFrame(error.to_string()))?,
                    ))
                    .await?;
                loop {
                    match events.recv().await {
                        Ok(event) if event.session_id == attachment.1 => {
                            if connection
                                .write(&ServerFrame::Event { event })
                                .await
                                .is_err()
                            {
                                detach_all(&kernel, attachments).await;
                                return Ok(());
                            }
                        }
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            detach_all(&kernel, attachments).await;
                            return Ok(());
                        }
                    }
                }
            }
            Err(error) => {
                connection
                    .write(&error_response(request_id, &error))
                    .await?;
            }
        }
    }
}

enum CommandResult {
    Reply {
        result: Value,
        attachment: Option<(String, String)>,
    },
    Observe {
        snapshot: SessionSnapshot,
        attachment: (String, String),
    },
}

async fn execute_command(
    kernel: &HostKernel,
    command: &HostCommand,
) -> Result<CommandResult, CommandError> {
    if command.protocol_version != CURRENT_PROTOCOL_VERSION {
        return Err(CommandError::ProtocolMismatch);
    }
    match command.kind.as_str() {
        "health" => Ok(CommandResult::Reply {
            result: json!({ "status": "ready" }),
            attachment: None,
        }),
        "session.create" => {
            let payload: CreatePayload = decode_payload(&command.payload)?;
            let snapshot = kernel
                .create_session(CreateSession {
                    client_id: command.client_id.clone(),
                    cwd: payload.cwd,
                })
                .await?;
            let attachment = Some((command.client_id.clone(), snapshot.session_id.clone()));
            Ok(CommandResult::Reply {
                result: serde_json::to_value(snapshot)?,
                attachment,
            })
        }
        "session.list" => Ok(CommandResult::Reply {
            result: serde_json::to_value(kernel.list_sessions().await?)?,
            attachment: None,
        }),
        "session.attach" => {
            let session_id = require_session_id(command)?;
            let snapshot = kernel
                .attach(command.client_id.clone(), session_id.clone())
                .await?;
            Ok(CommandResult::Reply {
                result: serde_json::to_value(snapshot)?,
                attachment: Some((command.client_id.clone(), session_id)),
            })
        }
        "session.snapshot" => {
            let snapshot = kernel.snapshot(require_session_id(command)?).await?;
            Ok(CommandResult::Reply {
                result: serde_json::to_value(snapshot)?,
                attachment: None,
            })
        }
        "session.prompt" => {
            let payload: PromptPayload = decode_payload(&command.payload)?;
            let session_id = require_session_id(command)?;
            let snapshot = kernel
                .prompt(PromptSession {
                    client_id: command.client_id.clone(),
                    session_id: session_id.clone(),
                    operation_id: command.operation_id.clone(),
                    expected_revision: require_revision(command)?,
                    text: payload.text,
                })
                .await?;
            Ok(CommandResult::Reply {
                result: serde_json::to_value(snapshot)?,
                attachment: Some((command.client_id.clone(), session_id)),
            })
        }
        "session.cancel" => {
            let payload: CancelPayload = decode_payload(&command.payload)?;
            let session_id = require_session_id(command)?;
            let snapshot = kernel
                .cancel(CancelSession {
                    client_id: command.client_id.clone(),
                    session_id: session_id.clone(),
                    operation_id: payload.operation_id,
                    expected_revision: require_revision(command)?,
                })
                .await?;
            Ok(CommandResult::Reply {
                result: serde_json::to_value(snapshot)?,
                attachment: Some((command.client_id.clone(), session_id)),
            })
        }
        "session.observe" => {
            let session_id = require_session_id(command)?;
            let snapshot = kernel
                .attach(command.client_id.clone(), session_id.clone())
                .await?;
            Ok(CommandResult::Observe {
                snapshot,
                attachment: (command.client_id.clone(), session_id),
            })
        }
        _ => Err(CommandError::UnsupportedCommand(command.kind.clone())),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatePayload {
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptPayload {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelPayload {
    operation_id: String,
}

fn decode_payload<T: for<'de> Deserialize<'de>>(payload: &Value) -> Result<T, CommandError> {
    serde_json::from_value(payload.clone()).map_err(CommandError::InvalidPayload)
}

fn require_session_id(command: &HostCommand) -> Result<String, CommandError> {
    command
        .session_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .ok_or(CommandError::MissingSessionId)
}

fn require_revision(command: &HostCommand) -> Result<u64, CommandError> {
    command
        .expected_revision
        .ok_or(CommandError::MissingRevision)
}

fn success_response(request_id: String, result: Value) -> ServerFrame {
    ServerFrame::Response {
        response: HostResponse {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            request_id,
            outcome: HostResponseOutcome::Ok { result },
        },
    }
}

fn error_response(request_id: String, error: &CommandError) -> ServerFrame {
    ServerFrame::Response {
        response: HostResponse {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            request_id,
            outcome: HostResponseOutcome::Error {
                error: protocol_error(error.code(), &error.to_string()),
            },
        },
    }
}

fn protocol_error(code: &str, message: &str) -> HostProtocolError {
    HostProtocolError {
        code: code.into(),
        message: message.chars().take(500).collect(),
        retryable: false,
        details: None,
    }
}

async fn detach_all(kernel: &HostKernel, attachments: BTreeSet<(String, String)>) {
    for (client_id, session_id) in attachments {
        let _ = kernel.detach(client_id, session_id).await;
    }
}

#[derive(Debug, thiserror::Error)]
enum CommandError {
    #[error("Host protocol version is incompatible")]
    ProtocolMismatch,
    #[error("Host command requires a session ID")]
    MissingSessionId,
    #[error("Host command requires an expected revision")]
    MissingRevision,
    #[error("unsupported Host command: {0}")]
    UnsupportedCommand(String),
    #[error("invalid Host command payload: {0}")]
    InvalidPayload(serde_json::Error),
    #[error(transparent)]
    Kernel(#[from] HostKernelError),
    #[error("Host response serialization failed: {0}")]
    Json(#[from] serde_json::Error),
}

impl CommandError {
    fn code(&self) -> &'static str {
        match self {
            Self::ProtocolMismatch => "protocol_version_mismatch",
            Self::MissingSessionId | Self::MissingRevision | Self::InvalidPayload(_) => {
                "invalid_request"
            }
            Self::UnsupportedCommand(_) => "unsupported_command",
            Self::Kernel(HostKernelError::UnknownSession(_)) => "unknown_session",
            Self::Kernel(HostKernelError::Broker(
                pi_tai_broker::BrokerError::RevisionConflict { .. },
            )) => "revision_conflict",
            Self::Kernel(_) => "host_operation_failed",
            Self::Json(_) => "serialization_failed",
        }
    }
}
