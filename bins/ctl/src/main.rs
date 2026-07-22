#![cfg(unix)]

use std::{path::PathBuf, time::Duration};

use clap::{Parser, Subcommand};
use pi_tai_host_protocol::{
    CURRENT_PROTOCOL_VERSION, ClientFrame, HostCommand, HostResponseOutcome, ImplementationInfo,
    ServerFrame,
};
use pi_tai_local_ipc::{AuthToken, IpcClient, IpcConnection};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "pi-tai-ctl", about = "Diagnostic client for Pi-Tai Host Agent")]
struct Cli {
    #[arg(long, env = "PI_TAI_HOST_SOCKET")]
    socket: PathBuf,
    #[arg(long, env = "PI_TAI_HOST_TOKEN_FILE")]
    token_file: PathBuf,
    #[arg(long, default_value = "pi-tai-ctl")]
    client_id: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Health,
    List,
    Create {
        cwd: PathBuf,
    },
    Attach {
        session_id: String,
    },
    Snapshot {
        session_id: String,
    },
    Prompt {
        session_id: String,
        revision: u64,
        text: String,
    },
    Cancel {
        session_id: String,
        revision: u64,
        operation_id: String,
    },
    Observe {
        session_id: String,
        #[arg(long)]
        until_idle: bool,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("pi-tai-ctl: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let token = AuthToken::load(&cli.token_file)?;
    let mut connection = IpcClient::connect(
        &cli.socket,
        &token,
        ImplementationInfo {
            name: "pi-tai-ctl".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        Duration::from_secs(5),
    )
    .await?;
    let (kind, session_id, expected_revision, payload, observe_until_idle) = match cli.command {
        Command::Health => ("health", None, None, json!({}), None),
        Command::List => ("session.list", None, None, json!({}), None),
        Command::Create { cwd } => (
            "session.create",
            None,
            None,
            json!({ "cwd": cwd.canonicalize()?.to_string_lossy() }),
            None,
        ),
        Command::Attach { session_id } => {
            ("session.attach", Some(session_id), None, json!({}), None)
        }
        Command::Snapshot { session_id } => {
            ("session.snapshot", Some(session_id), None, json!({}), None)
        }
        Command::Prompt {
            session_id,
            revision,
            text,
        } => (
            "session.prompt",
            Some(session_id),
            Some(revision),
            json!({ "text": text }),
            None,
        ),
        Command::Cancel {
            session_id,
            revision,
            operation_id,
        } => (
            "session.cancel",
            Some(session_id),
            Some(revision),
            json!({ "operationId": operation_id }),
            None,
        ),
        Command::Observe {
            session_id,
            until_idle,
        } => (
            "session.observe",
            Some(session_id),
            None,
            json!({}),
            Some(until_idle),
        ),
    };
    let operation_id = Uuid::now_v7().to_string();
    connection
        .write(&ClientFrame::Command {
            command: HostCommand {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                request_id: Uuid::now_v7().to_string(),
                operation_id,
                client_id: cli.client_id,
                session_id,
                expected_revision,
                kind: kind.into(),
                payload,
            },
        })
        .await?;
    print_response(&mut connection).await?;
    if let Some(until_idle) = observe_until_idle {
        loop {
            let frame: ServerFrame = connection.read().await?;
            match frame {
                ServerFrame::Event { event } => {
                    let is_idle = event.event_type == "session.idle";
                    println!("{}", serde_json::to_string(&event)?);
                    if until_idle && is_idle {
                        break;
                    }
                }
                ServerFrame::Error { error } => {
                    return Err(error.message.into());
                }
                ServerFrame::Response { .. } | ServerFrame::Authenticated { .. } => {}
            }
        }
    }
    Ok(())
}

async fn print_response(connection: &mut IpcConnection) -> Result<(), Box<dyn std::error::Error>> {
    let frame: ServerFrame = connection.read().await?;
    let ServerFrame::Response { response } = frame else {
        return Err("expected Host response".into());
    };
    match response.outcome {
        HostResponseOutcome::Ok { result } => print_json(&result)?,
        HostResponseOutcome::Error { error } => return Err(error.message.into()),
    }
    Ok(())
}

fn print_json(value: &Value) -> Result<(), serde_json::Error> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
