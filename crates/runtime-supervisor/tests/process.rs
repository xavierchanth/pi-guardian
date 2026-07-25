use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use pi_tai_config::schema::default_config;
use pi_tai_runtime_protocol::SessionInfo;
use pi_tai_runtime_supervisor::{RuntimeProcessSpec, RuntimeSupervisor, SupervisorNotice};
use serde_json::json;

fn fake_worker_script() -> &'static str {
    r#"
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let generation = 0;
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.method === 'runtime.initialize') {
    generation = command.params.runtimeGeneration;
    process.stdout.write(JSON.stringify({
      protocolVersion: 2, kind: 'response', id: command.id, ok: true,
      result: {
        protocolVersion: 2,
        workerId: command.params.workerId,
        runtimeGeneration: generation,
        capabilities: { methods: [], tools: [], commands: [], sessionCapabilities: [], extensionErrors: [] }
      }
    }) + '\n');
  } else if (command.method === 'test.echo') {
    process.stdout.write(JSON.stringify({
      protocolVersion: 2, kind: 'response', id: command.id, ok: true, result: command.params
    }) + '\n');
    process.stdout.write(JSON.stringify({
      protocolVersion: 2, kind: 'event', workerSequence: 1,
      runtimeGeneration: generation - 1, event: 'stale.event', data: {}
    }) + '\n');
    process.stdout.write(JSON.stringify({
      protocolVersion: 2, kind: 'event', workerSequence: 2,
      runtimeGeneration: generation, event: 'runtime.ready', data: {}
    }) + '\n');
  } else if (command.method === 'runtime.shutdown') {
    process.stdout.write(JSON.stringify({
      protocolVersion: 2, kind: 'response', id: command.id, ok: true, result: {}
    }) + '\n');
    process.exit(0);
  }
});
"#
}

fn spec() -> RuntimeProcessSpec {
    RuntimeProcessSpec {
        executable: PathBuf::from("node"),
        args: vec!["-e".into(), fake_worker_script().into()],
        cwd: None,
        env: BTreeMap::new(),
    }
}

#[tokio::test]
async fn handshakes_routes_responses_and_rejects_stale_generation_events() {
    let started = RuntimeSupervisor::spawn(spec(), "worker-test", 7)
        .await
        .unwrap();
    assert_eq!(started.initialize.worker_id, "worker-test");
    assert_eq!(started.initialize.runtime_generation, 7);

    let mut notices = started.handle.subscribe();
    let response = started
        .handle
        .request("test.echo", json!({ "value": 42 }))
        .await
        .unwrap();
    assert_eq!(response.result, Some(json!({ "value": 42 })));

    let mut saw_stale = false;
    let mut saw_ready = false;
    for _ in 0..4 {
        let notice = tokio::time::timeout(Duration::from_secs(2), notices.recv())
            .await
            .unwrap()
            .unwrap();
        match notice {
            SupervisorNotice::StaleRuntimeEvent {
                received, expected, ..
            } => {
                assert_eq!((received, expected), (6, 7));
                saw_stale = true;
            }
            SupervisorNotice::RuntimeEvent(event) if event.event == "runtime.ready" => {
                saw_ready = true;
            }
            _ => {}
        }
        if saw_stale && saw_ready {
            break;
        }
    }
    assert!(saw_stale && saw_ready);

    started.handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn supervises_the_real_typescript_worker_boundary() {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let temporary = tempfile::tempdir().unwrap();
    let cwd = temporary.path().join("workspace");
    let agent_dir = temporary.path().join("agent");
    let session_dir = temporary.path().join("sessions");
    for path in [&cwd, &agent_dir, &session_dir] {
        std::fs::create_dir_all(path).unwrap();
    }
    let mut env = BTreeMap::new();
    env.insert("PI_TAI_RUNTIME_FAKE_PORT".into(), "1".into());
    let started = RuntimeSupervisor::spawn(
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
        },
        "real-worker-boundary",
        11,
    )
    .await
    .unwrap();

    let response = started
        .handle
        .request(
            "session.create",
            json!({
                "cwd": cwd,
                "agentDir": agent_dir,
                "sessionDir": session_dir,
                "sessionPolicy": default_config().session_policy,
                "policyProvenance": {},
                "faux": true
            }),
        )
        .await
        .unwrap();
    let session: SessionInfo = serde_json::from_value(response.result.unwrap()).unwrap();
    assert_eq!(session.cwd, cwd.to_string_lossy());
    assert!(!session.session_id.is_empty());
    started.handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn reports_worker_exit_without_fabricating_a_runtime_event() {
    let started = RuntimeSupervisor::spawn(spec(), "worker-exit", 3)
        .await
        .unwrap();
    let mut notices = started.handle.subscribe();
    started.handle.shutdown().await.unwrap();

    loop {
        let notice = tokio::time::timeout(Duration::from_secs(2), notices.recv())
            .await
            .unwrap()
            .unwrap();
        if let SupervisorNotice::WorkerExited { success, .. } = notice {
            assert!(success);
            break;
        }
    }
}
