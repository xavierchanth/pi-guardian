#![cfg(unix)]

use std::time::Duration;

use pi_tai_host_protocol::{
    CURRENT_PROTOCOL_VERSION, ClientFrame, ImplementationInfo, ServerFrame,
};
use pi_tai_local_ipc::{AuthToken, IpcClient, IpcListener};

fn implementation(name: &str) -> ImplementationInfo {
    ImplementationInfo {
        name: name.into(),
        version: "0.1.0".into(),
    }
}

#[tokio::test]
async fn authenticates_before_exposing_application_frames() {
    let temporary = tempfile::tempdir().unwrap();
    let socket = temporary.path().join("host.sock");
    let token = AuthToken::generate();
    let listener = IpcListener::bind(&socket, token.clone(), implementation("host"))
        .await
        .unwrap();

    let server = tokio::spawn(async move {
        let mut connection = listener.accept().await.unwrap();
        let first: ClientFrame = connection.read().await.unwrap();
        assert!(matches!(first, ClientFrame::Command { .. }));
        connection
            .write(&ServerFrame::Error {
                error: pi_tai_host_protocol::HostProtocolError {
                    code: "proof_complete".into(),
                    message: "round trip complete".into(),
                    retryable: false,
                    details: None,
                },
            })
            .await
            .unwrap();
    });

    let mut client = IpcClient::connect(
        &socket,
        &token,
        implementation("diagnostic-client"),
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    client
        .write(&ClientFrame::Command {
            command: pi_tai_host_protocol::HostCommand {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                request_id: "request-1".into(),
                operation_id: "operation-1".into(),
                client_id: "client-1".into(),
                session_id: None,
                expected_revision: None,
                kind: "health".into(),
                payload: serde_json::json!({}),
            },
        })
        .await
        .unwrap();
    let response: ServerFrame = client.read().await.unwrap();
    assert!(matches!(response, ServerFrame::Error { error } if error.code == "proof_complete"));
    server.await.unwrap();
}

#[tokio::test]
async fn rejects_an_incorrect_token_without_reading_commands() {
    let temporary = tempfile::tempdir().unwrap();
    let socket = temporary.path().join("host.sock");
    let token = AuthToken::generate();
    let wrong = AuthToken::generate();
    let listener = IpcListener::bind(&socket, token, implementation("host"))
        .await
        .unwrap();
    let server = tokio::spawn(async move { listener.accept().await });

    let result = IpcClient::connect(
        &socket,
        &wrong,
        implementation("untrusted-client"),
        Duration::from_secs(2),
    )
    .await;
    assert!(result.is_err());
    assert!(server.await.unwrap().is_err());
}

#[test]
fn token_files_are_private_and_stable() {
    use std::os::unix::fs::PermissionsExt;

    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("host.token");
    let first = AuthToken::load_or_create(&path).unwrap();
    let second = AuthToken::load_or_create(&path).unwrap();

    assert_eq!(first, second);
    let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}
