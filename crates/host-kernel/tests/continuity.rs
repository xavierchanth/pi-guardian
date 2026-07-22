use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use pi_tai_host_kernel::{
    CreateSession, ForegroundSnapshot, HostKernel, HostKernelConfig, PromptSession, RuntimeSnapshot,
};
use pi_tai_runtime_supervisor::RuntimeProcessSpec;

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

#[tokio::test]
async fn a_turn_survives_client_detach_and_continues_for_an_observer() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let kernel = HostKernel::start(HostKernelConfig {
        runtime: runtime_spec(),
        agent_dir: temporary.path().join("agent"),
        session_dir: temporary.path().join("sessions"),
        faux: true,
    });
    let first_client = "diagnostic-first".to_string();
    let created = kernel
        .create_session(CreateSession {
            client_id: first_client.clone(),
            cwd: workspace.to_string_lossy().into_owned(),
        })
        .await
        .unwrap();
    let mut events = kernel.subscribe();
    let prompted = kernel
        .prompt(PromptSession {
            client_id: first_client.clone(),
            session_id: created.session_id.clone(),
            operation_id: "operation-slow".into(),
            expected_revision: created.revision,
            text: "slow proof".into(),
        })
        .await
        .unwrap();
    assert!(matches!(
        prompted.foreground,
        ForegroundSnapshot::Running { .. }
    ));

    kernel
        .detach(first_client, created.session_id.clone())
        .await
        .unwrap();
    let detached = kernel.snapshot(created.session_id.clone()).await.unwrap();
    assert!(matches!(
        detached.foreground,
        ForegroundSnapshot::Running { .. }
    ));
    assert_eq!(detached.attachment_count, 0);

    let attached = kernel
        .attach("diagnostic-second".into(), created.session_id.clone())
        .await
        .unwrap();
    assert_eq!(attached.attachment_count, 1);

    let mut text = String::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        if event.session_id != created.session_id {
            continue;
        }
        if event.event_type == "assistant.text_delta" {
            text.push_str(event.payload["delta"].as_str().unwrap());
        }
        if event.event_type == "session.idle" {
            break;
        }
    }
    assert_eq!(text, "slow response");
    let complete = kernel.snapshot(created.session_id).await.unwrap();
    assert!(matches!(
        complete.foreground,
        ForegroundSnapshot::Idle { .. }
    ));
    assert!(matches!(complete.runtime, RuntimeSnapshot::Ready { .. }));
    kernel.shutdown().await.unwrap();
}
