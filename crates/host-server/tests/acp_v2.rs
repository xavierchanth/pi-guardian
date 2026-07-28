#![cfg(unix)]

use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};

use pi_tai_host_kernel::{HostKernel, HostKernelConfig};
use pi_tai_host_protocol::ImplementationInfo;
use pi_tai_host_server::HostIpcServer;
use pi_tai_local_ipc::{AuthToken, IpcListener};
use pi_tai_runtime_supervisor::RuntimeProcessSpec;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
};

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn runtime_spec() -> RuntimeProcessSpec {
    let mut env = BTreeMap::new();
    env.insert("PI_TAI_RUNTIME_FAKE_PORT".into(), "1".into());
    RuntimeProcessSpec {
        executable: PathBuf::from("node"),
        args: vec![
            "--experimental-strip-types".into(),
            repository()
                .join("services/pi-runtime/src/bootstrap.ts")
                .to_string_lossy()
                .into_owned(),
        ],
        cwd: Some(repository()),
        env,
    }
}

struct AcpProcess {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}

impl AcpProcess {
    async fn spawn(socket: &std::path::Path, token_file: &std::path::Path) -> Self {
        let mut child = Command::new("node")
            .arg("--experimental-strip-types")
            .arg(repository().join("bins/acp/src/main.ts"))
            .arg("--experimental-acp-v2")
            .env("PI_TAI_HOST_SOCKET", socket)
            .env("PI_TAI_HOST_TOKEN_FILE", token_file)
            .current_dir(repository())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
        }
    }

    async fn send(&mut self, value: Value) {
        self.stdin
            .write_all(format!("{}\n", serde_json::to_string(&value).unwrap()).as_bytes())
            .await
            .unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn response(&mut self, id: u64) -> (Value, Vec<Value>) {
        let mut notifications = Vec::new();
        loop {
            let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .expect("ACP process exited before responding");
            let message: Value = serde_json::from_str(&line).unwrap();
            if message["id"].as_u64() == Some(id) {
                return (message, notifications);
            }
            notifications.push(message);
        }
    }

    async fn initialize(&mut self, id: u64) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": 2,
                "info": { "name": "acp-proof", "version": "0.1.0" },
                "capabilities": {}
            }
        }))
        .await;
        let (response, _) = self.response(id).await;
        assert_eq!(response["result"]["capabilities"]["session"], json!({}));
    }

    async fn kill(mut self) {
        self.child.kill().await.unwrap();
        let _ = self.child.wait().await;
    }
}

fn updates(messages: &[Value]) -> impl Iterator<Item = &Value> {
    messages.iter().filter_map(|message| {
        (message["method"] == "session/update").then_some(&message["params"]["update"])
    })
}

#[tokio::test]
async fn official_acp_stdio_reconnects_to_a_host_owned_turn_with_durable_replay() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let socket = temporary.path().join("host.sock");
    let token_file = temporary.path().join("host.token");
    let token = AuthToken::load_or_create(&token_file).unwrap();
    let listener = IpcListener::bind(
        &socket,
        token,
        ImplementationInfo {
            name: "host-proof".into(),
            version: "0.1.0".into(),
        },
    )
    .unwrap();
    let kernel = HostKernel::start(HostKernelConfig {
        runtime: runtime_spec(),
        agent_dir: temporary.path().join("agent"),
        session_dir: temporary.path().join("sessions"),
        database_path: temporary.path().join("broker.sqlite3"),
        faux: true,
    })
    .unwrap();
    let server_kernel = kernel.clone();
    let server = tokio::spawn(HostIpcServer::new(listener, kernel).run());

    let mut first = AcpProcess::spawn(&socket, &token_file).await;
    first.initialize(1).await;
    first
        .send(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": { "cwd": workspace }
        }))
        .await;
    let (created, _) = first.response(2).await;
    let session_id = created["result"]["sessionId"].as_str().unwrap().to_owned();
    first
        .send(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "slow ACP proof" }]
            }
        }))
        .await;
    let (accepted, before_detach) = first.response(3).await;
    assert_eq!(accepted["result"], json!({}));
    assert!(updates(&before_detach).next().is_none());
    first.kill().await;

    let mut second = AcpProcess::spawn(&socket, &token_file).await;
    second.initialize(10).await;
    second
        .send(json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "session/resume",
            "params": {
                "sessionId": session_id,
                "cwd": workspace,
                "replayFrom": { "type": "start" }
            }
        }))
        .await;
    let (resumed, mut messages) = second.response(11).await;
    assert_eq!(resumed["result"], json!({}));

    while !updates(&messages)
        .any(|update| update["sessionUpdate"] == "state_update" && update["state"] == "idle")
    {
        let line = tokio::time::timeout(Duration::from_secs(5), second.lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .expect("ACP process exited during resumed turn");
        messages.push(serde_json::from_str(&line).unwrap());
    }
    let replayed_updates = updates(&messages).collect::<Vec<_>>();
    assert!(
        replayed_updates
            .iter()
            .any(|update| update["sessionUpdate"] == "user_message")
    );
    let text = replayed_updates
        .iter()
        .filter(|update| update["sessionUpdate"] == "agent_message_chunk")
        .filter_map(|update| update["content"]["text"].as_str())
        .collect::<String>();
    assert_eq!(text, "slow response");

    second.kill().await;
    server_kernel.shutdown().await.unwrap();
    server.abort();
}
