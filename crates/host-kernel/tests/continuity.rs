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
            client_asserted_project_trust: false,
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
    let mut usage = None;
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
        if event.event_type == "usage.replaced" {
            usage = Some(event.payload.clone());
        }
        if event.event_type == "session.idle" {
            break;
        }
    }
    assert_eq!(text, "slow response");
    let usage = usage.expect("usage projection");
    assert_eq!(
        (
            usage["total"]["input"].as_u64(),
            usage["total"]["output"].as_u64(),
            usage["total"]["cost"].as_f64()
        ),
        (Some(2), Some(3), Some(0.03))
    );
    assert_eq!(usage["byModel"]["pi-tai/faux"]["output"].as_u64(), Some(3));
    let complete = kernel.snapshot(created.session_id).await.unwrap();
    assert!(matches!(
        complete.foreground,
        ForegroundSnapshot::Idle { .. }
    ));
    assert!(matches!(complete.runtime, RuntimeSnapshot::Ready { .. }));
    kernel.shutdown().await.unwrap();
}

#[tokio::test]
async fn runtime_core_transactions_are_host_acknowledged_and_projected() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let kernel = HostKernel::start(kernel_config(&temporary)).unwrap();
    let created = kernel
        .create_session(CreateSession {
            client_id: "core-client".into(),
            cwd: workspace.to_string_lossy().into_owned(),
            client_asserted_project_trust: false,
        })
        .await
        .unwrap();
    let mut events = kernel.subscribe();
    kernel
        .prompt(PromptSession {
            client_id: "core-client".into(),
            session_id: created.session_id.clone(),
            operation_id: "operation-host-service".into(),
            expected_revision: created.revision,
            text: "host-service proof".into(),
        })
        .await
        .unwrap();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        if event.session_id == created.session_id && event.event_type == "session.idle" {
            break;
        }
    }
    let replay = kernel
        .replay(created.session_id.clone(), 0, 100)
        .await
        .unwrap();
    let projected = replay
        .iter()
        .find(|event| event.event_type == "concurrency.replaced")
        .expect("Host concurrency projection event");
    assert_eq!(projected.payload["revision"], 1);
    assert_eq!(projected.payload["projection"]["version"], 1);
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
            client_asserted_project_trust: false,
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
async fn resolved_policy_projection_rebuilds_from_canonical_event() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config = kernel_config(&temporary);
    std::fs::create_dir_all(&config.agent_dir).unwrap();
    std::fs::write(
        config.agent_dir.join("pi-tai.json"),
        r#"{"compaction":{"thresholdPercent":65}}"#,
    )
    .unwrap();
    let first = HostKernel::start(config.clone()).unwrap();
    let created = first
        .create_session(CreateSession {
            client_id: "rebuild-client".into(),
            cwd: workspace.to_string_lossy().into_owned(),
            client_asserted_project_trust: false,
        })
        .await
        .unwrap();
    first.shutdown().await.unwrap();

    let connection = rusqlite::Connection::open(&config.database_path).unwrap();
    let snapshot_json: String = connection
        .query_row(
            "SELECT snapshot_json FROM broker_sessions WHERE session_id = ?1",
            [&created.session_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();
    snapshot.as_object_mut().unwrap().remove("resolvedPolicy");
    connection
        .execute(
            "UPDATE broker_sessions SET snapshot_json = ?1 WHERE session_id = ?2",
            rusqlite::params![
                serde_json::to_string(&snapshot).unwrap(),
                created.session_id
            ],
        )
        .unwrap();
    drop(connection);
    std::fs::write(
        config.agent_dir.join("pi-tai.json"),
        r#"{"compaction":{"thresholdPercent":25}}"#,
    )
    .unwrap();

    let recovered = HostKernel::start(config).unwrap();
    let session = recovered.list_sessions().await.unwrap().remove(0);
    assert_eq!(
        session
            .resolved_policy
            .unwrap()
            .session_policy
            .compaction
            .threshold_percent,
        65.0
    );
    recovered.shutdown().await.unwrap();
}

#[tokio::test]
async fn old_projection_backfills_policy_once_and_keeps_it_durable() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config = kernel_config(&temporary);
    let first = HostKernel::start(config.clone()).unwrap();
    let created = first
        .create_session(CreateSession {
            client_id: "backfill-client".into(),
            cwd: workspace.to_string_lossy().into_owned(),
            client_asserted_project_trust: false,
        })
        .await
        .unwrap();
    first.shutdown().await.unwrap();

    let connection = rusqlite::Connection::open(&config.database_path).unwrap();
    let snapshot_json: String = connection
        .query_row(
            "SELECT snapshot_json FROM broker_sessions WHERE session_id = ?1",
            [&created.session_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();
    snapshot.as_object_mut().unwrap().remove("resolvedPolicy");
    connection
        .execute(
            "UPDATE broker_sessions SET snapshot_json = ?1 WHERE session_id = ?2",
            rusqlite::params![
                serde_json::to_string(&snapshot).unwrap(),
                created.session_id
            ],
        )
        .unwrap();
    connection
        .execute(
            "DELETE FROM session_events WHERE session_id = ?1 AND event_type = 'session.policy_resolved'",
            [&created.session_id],
        )
        .unwrap();
    drop(connection);

    let recovered = HostKernel::start(config.clone()).unwrap();
    assert!(
        recovered.list_sessions().await.unwrap()[0]
            .resolved_policy
            .is_some()
    );
    recovered.shutdown().await.unwrap();
    let recovered_again = HostKernel::start(config).unwrap();
    let replay = recovered_again
        .replay(created.session_id, 0, 100)
        .await
        .unwrap();
    assert_eq!(
        replay
            .iter()
            .filter(|event| event.event_type == "session.policy_resolved")
            .count(),
        1
    );
    recovered_again.shutdown().await.unwrap();
}

#[tokio::test]
async fn restart_recovers_stable_identity_and_replays_durable_events() {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config = kernel_config(&temporary);
    std::fs::create_dir_all(&config.agent_dir).unwrap();
    std::fs::write(
        config.agent_dir.join("pi-tai.json"),
        r#"{"compaction":{"thresholdPercent":70}}"#,
    )
    .unwrap();
    let first = HostKernel::start(config.clone()).unwrap();
    let created = first
        .create_session(CreateSession {
            client_id: "recovery-client".into(),
            cwd: workspace.to_string_lossy().into_owned(),
            client_asserted_project_trust: false,
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
    assert_eq!(
        before_restart
            .first()
            .map(|event| event.event_type.as_str()),
        Some("session.policy_resolved")
    );
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
    std::fs::write(
        config.agent_dir.join("pi-tai.json"),
        r#"{"compaction":{"thresholdPercent":30}}"#,
    )
    .unwrap();

    let recovered = HostKernel::start(config.clone()).unwrap();
    let sessions = recovered.list_sessions().await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, created.session_id);
    assert!(sessions[0].runtime_generation > old_generation);
    assert!(matches!(sessions[0].runtime, RuntimeSnapshot::Ready { .. }));
    assert_eq!(sessions[0].attachment_count, 0);
    assert_eq!(
        sessions[0]
            .resolved_policy
            .as_ref()
            .unwrap()
            .session_policy
            .compaction
            .threshold_percent,
        70.0
    );

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
    assert_eq!(
        replayed
            .iter()
            .filter(|event| event.event_type == "session.policy_resolved")
            .count(),
        1
    );

    let new_workspace = temporary.path().join("new-workspace");
    std::fs::create_dir_all(&new_workspace).unwrap();
    let new_session = recovered
        .create_session(CreateSession {
            client_id: "new-policy-client".into(),
            cwd: new_workspace.to_string_lossy().into_owned(),
            client_asserted_project_trust: false,
        })
        .await
        .unwrap();
    assert_eq!(
        new_session
            .resolved_policy
            .unwrap()
            .session_policy
            .compaction
            .threshold_percent,
        30.0
    );
    recovered.shutdown().await.unwrap();
}
