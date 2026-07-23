use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use pi_tai_host_kernel::{
    CreateSession, ForegroundSnapshot, HostKernel, HostKernelConfig, HostKernelError,
    PromptSession, RuntimeSnapshot,
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

fn kernel_config(temporary: &tempfile::TempDir) -> HostKernelConfig {
    HostKernelConfig {
        runtime: runtime_spec(),
        agent_dir: temporary.path().join("agent"),
        session_dir: temporary.path().join("sessions"),
        database_path: temporary.path().join("broker.sqlite3"),
        faux: true,
    }
}

#[tokio::test]
async fn a_turn_survives_client_detach_and_continues_for_an_observer() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let kernel = HostKernel::start(kernel_config(&temporary)).unwrap();
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

#[tokio::test]
async fn restart_marks_an_unfinished_turn_interrupted_without_replaying_it() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config = kernel_config(&temporary);
    let first = HostKernel::start(config.clone()).unwrap();
    let created = first
        .create_session(CreateSession {
            client_id: "interrupted-client".into(),
            cwd: workspace.to_string_lossy().into_owned(),
        })
        .await
        .unwrap();
    first
        .prompt(PromptSession {
            client_id: "interrupted-client".into(),
            session_id: created.session_id.clone(),
            operation_id: "operation-interrupted".into(),
            expected_revision: created.revision,
            text: "slow unfinished proof".into(),
        })
        .await
        .unwrap();
    assert!(first.shutdown().await.is_err());

    let recovered = HostKernel::start(config).unwrap();
    let snapshot = recovered
        .snapshot(created.session_id.clone())
        .await
        .unwrap();
    assert!(matches!(snapshot.runtime, RuntimeSnapshot::Ready { .. }));
    assert!(matches!(
        snapshot.foreground,
        ForegroundSnapshot::Idle {
            last_stop_reason: Some(ref reason)
        } if reason == "interrupted"
    ));
    let replay = recovered.replay(created.session_id, 0, 100).await.unwrap();
    assert_eq!(
        replay
            .iter()
            .filter(|event| event.event_type == "user.message")
            .count(),
        1
    );
    recovered.shutdown().await.unwrap();
}

#[tokio::test]
async fn restart_recovers_stable_identity_and_replays_durable_events() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config = kernel_config(&temporary);
    let first = HostKernel::start(config.clone()).unwrap();
    let created = first
        .create_session(CreateSession {
            client_id: "recovery-client".into(),
            cwd: workspace.to_string_lossy().into_owned(),
        })
        .await
        .unwrap();
    let mut live = first.subscribe();
    let prompt = PromptSession {
        client_id: "recovery-client".into(),
        session_id: created.session_id.clone(),
        operation_id: "operation-before-restart".into(),
        expected_revision: created.revision,
        text: "recovery proof".into(),
    };
    let accepted = first.prompt(prompt.clone()).await.unwrap();
    let duplicate = first.prompt(prompt).await.unwrap();
    assert_eq!(duplicate, accepted);
    let conflict = first
        .prompt(PromptSession {
            client_id: "recovery-client".into(),
            session_id: created.session_id.clone(),
            operation_id: "operation-with-stale-revision".into(),
            expected_revision: created.revision,
            text: "must conflict".into(),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        conflict,
        HostKernelError::Broker(pi_tai_broker::BrokerError::RevisionConflict { .. })
    ));
    loop {
        let event = tokio::time::timeout(Duration::from_secs(3), live.recv())
            .await
            .unwrap()
            .unwrap();
        if event.session_id == created.session_id && event.event_type == "session.idle" {
            break;
        }
    }
    let before_restart = first
        .replay(created.session_id.clone(), 0, 100)
        .await
        .unwrap();
    assert!(
        before_restart
            .iter()
            .any(|event| event.event_type == "assistant.text_delta")
    );
    assert_eq!(
        before_restart
            .iter()
            .filter(|event| event.event_type == "user.message")
            .count(),
        1
    );
    let old_generation = first
        .snapshot(created.session_id.clone())
        .await
        .unwrap()
        .runtime_generation;
    first.shutdown().await.unwrap();

    let recovered = HostKernel::start(config).unwrap();
    let sessions = recovered.list_sessions().await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, created.session_id);
    assert!(sessions[0].runtime_generation > old_generation);
    assert!(matches!(sessions[0].runtime, RuntimeSnapshot::Ready { .. }));
    assert_eq!(sessions[0].attachment_count, 0);

    let replayed = recovered
        .replay(created.session_id.clone(), 0, 100)
        .await
        .unwrap();
    assert!(replayed.len() > before_restart.len());
    assert!(
        replayed
            .windows(2)
            .all(|events| events[0].sequence + 1 == events[1].sequence)
    );
    assert!(
        replayed
            .iter()
            .any(|event| event.event_type == "runtime.recovered")
    );
    assert!(
        replayed
            .iter()
            .any(|event| event.event_type == "session.replaced")
    );
    recovered.shutdown().await.unwrap();
}
