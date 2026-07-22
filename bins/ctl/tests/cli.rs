#![cfg(unix)]

use std::{collections::BTreeMap, path::PathBuf};

use pi_tai_host_kernel::{HostKernel, HostKernelConfig, SessionSnapshot};
use pi_tai_host_protocol::ImplementationInfo;
use pi_tai_host_server::HostIpcServer;
use pi_tai_local_ipc::{AuthToken, IpcListener};
use pi_tai_runtime_supervisor::RuntimeProcessSpec;
use tokio::process::Command;

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

async fn ctl(socket: &std::path::Path, token: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_pi-tai-ctl"))
        .args(["--socket", socket.to_str().unwrap()])
        .args(["--token-file", token.to_str().unwrap()])
        .args(["--client-id", "cli-proof"])
        .args(args)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "ctl failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
async fn cli_starts_detaches_and_reobserves_a_host_owned_turn() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let kernel = HostKernel::start(HostKernelConfig {
        runtime: runtime_spec(),
        agent_dir: temporary.path().join("agent"),
        session_dir: temporary.path().join("sessions"),
        faux: true,
    });
    let socket = temporary.path().join("host.sock");
    let token_file = temporary.path().join("host.token");
    let token = AuthToken::load_or_create(&token_file).unwrap();
    let listener = IpcListener::bind(
        &socket,
        token,
        ImplementationInfo {
            name: "test-host".into(),
            version: "0.1.0".into(),
        },
    )
    .unwrap();
    let server_kernel = kernel.clone();
    let server = tokio::spawn(HostIpcServer::new(listener, kernel).run());

    assert!(
        ctl(&socket, &token_file, &["health"])
            .await
            .contains("ready")
    );
    let created: SessionSnapshot = serde_json::from_str(
        &ctl(
            &socket,
            &token_file,
            &["create", workspace.to_str().unwrap()],
        )
        .await,
    )
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let current: SessionSnapshot =
        serde_json::from_str(&ctl(&socket, &token_file, &["snapshot", &created.session_id]).await)
            .unwrap();
    ctl(
        &socket,
        &token_file,
        &[
            "prompt",
            &created.session_id,
            &current.revision.to_string(),
            "slow proof",
        ],
    )
    .await;
    let observed = ctl(
        &socket,
        &token_file,
        &["observe", &created.session_id, "--until-idle"],
    )
    .await;
    assert!(observed.contains("assistant.text_delta"));
    assert!(observed.contains("session.idle"));
    server_kernel.shutdown().await.unwrap();
    server.abort();
}
