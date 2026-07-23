#![cfg(unix)]

use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use pi_tai_host_kernel::{HostKernel, HostKernelConfig, SessionSnapshot};
use pi_tai_host_protocol::{
    CURRENT_PROTOCOL_VERSION, ClientFrame, HostCommand, HostResponseOutcome, ImplementationInfo,
    ServerFrame,
};
use pi_tai_host_server::HostIpcServer;
use pi_tai_local_ipc::{AuthToken, IpcClient, IpcConnection, IpcListener};
use pi_tai_runtime_supervisor::RuntimeProcessSpec;
use serde_json::{Value, json};

fn implementation(name: &str) -> ImplementationInfo {
    ImplementationInfo {
        name: name.into(),
        version: "0.1.0".into(),
    }
}

fn runtime_spec() -> RuntimeProcessSpec {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut env = BTreeMap::new();
    env.insert("PI_TAI_RUNTIME_FAKE_PORT".into(), "1".into());
    RuntimeProcessSpec {
        executable: PathBuf::from("node"),
        args: vec![
            "--experimental-strip-types".into(),
            repository
                .join("services/pi-runtime/src/bootstrap.ts")
                .to_string_lossy()
                .into_owned(),
        ],
        cwd: Some(repository),
        env,
    }
}

fn command(
    request_id: &str,
    operation_id: &str,
    client_id: &str,
    session_id: Option<String>,
    expected_revision: Option<u64>,
    kind: &str,
    payload: Value,
) -> ClientFrame {
    ClientFrame::Command {
        command: HostCommand {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            request_id: request_id.into(),
            operation_id: operation_id.into(),
            client_id: client_id.into(),
            session_id,
            expected_revision,
            kind: kind.into(),
            payload,
        },
    }
}

async fn response(connection: &mut IpcConnection) -> Value {
    let ServerFrame::Response { response } = connection.read().await.unwrap() else {
        panic!("expected Host response")
    };
    match response.outcome {
        HostResponseOutcome::Ok { result } => result,
        HostResponseOutcome::Error { error } => panic!("Host error: {error:?}"),
    }
}

#[tokio::test]
async fn reconnecting_observer_receives_the_rest_of_a_detached_turn() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let kernel = HostKernel::start(HostKernelConfig {
        runtime: runtime_spec(),
        agent_dir: temporary.path().join("agent"),
        session_dir: temporary.path().join("sessions"),
        database_path: temporary.path().join("broker.sqlite3"),
        faux: true,
    })
    .unwrap();
    let socket = temporary.path().join("host.sock");
    let token = AuthToken::generate();
    let listener = IpcListener::bind(&socket, token.clone(), implementation("host")).unwrap();
    let server_kernel = kernel.clone();
    let server = tokio::spawn(HostIpcServer::new(listener, kernel).run());

    let mut first = IpcClient::connect(
        &socket,
        &token,
        implementation("first-client"),
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    first
        .write(&command(
            "request-create",
            "operation-create",
            "client-first",
            None,
            None,
            "session.create",
            json!({ "cwd": workspace }),
        ))
        .await
        .unwrap();
    let created: SessionSnapshot = serde_json::from_value(response(&mut first).await).unwrap();
    first
        .write(&command(
            "request-prompt",
            "operation-slow",
            "client-first",
            Some(created.session_id.clone()),
            Some(created.revision),
            "session.prompt",
            json!({ "text": "slow proof" }),
        ))
        .await
        .unwrap();
    let running: SessionSnapshot = serde_json::from_value(response(&mut first).await).unwrap();
    drop(first);

    let mut observer = IpcClient::connect(
        &socket,
        &token,
        implementation("observer"),
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    observer
        .write(&command(
            "request-observe",
            "operation-observe",
            "client-observer",
            Some(created.session_id.clone()),
            Some(running.revision),
            "session.observe",
            json!({ "replayFromStart": true }),
        ))
        .await
        .unwrap();
    let observed = response(&mut observer).await;
    let _: SessionSnapshot = serde_json::from_value(observed["snapshot"].clone()).unwrap();
    let replay: Vec<pi_tai_host_protocol::HostEvent> =
        serde_json::from_value(observed["replay"].clone()).unwrap();
    let high_water = observed["highWaterSequence"].as_u64().unwrap();
    assert_eq!(replay.last().map(|event| event.sequence), Some(high_water));

    let mut text = replay
        .iter()
        .filter(|event| event.event_type == "assistant.text_delta")
        .filter_map(|event| event.payload["delta"].as_str())
        .collect::<String>();
    let mut idle = replay
        .iter()
        .any(|event| event.event_type == "session.idle");
    while !idle {
        let frame = tokio::time::timeout(Duration::from_secs(3), observer.read::<ServerFrame>())
            .await
            .unwrap()
            .unwrap();
        let ServerFrame::Event { event } = frame else {
            continue;
        };
        assert!(event.sequence > high_water);
        if event.event_type == "assistant.text_delta" {
            text.push_str(event.payload["delta"].as_str().unwrap());
        }
        idle = event.event_type == "session.idle";
    }
    assert_eq!(text, "slow response");
    drop(observer);
    server_kernel.shutdown().await.unwrap();
    server.abort();
}
