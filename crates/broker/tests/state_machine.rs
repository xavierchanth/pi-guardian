use pi_tai_broker::{
    BrokerSession, BrokerSessionId, ClientId, ForegroundState, OperationId, PiSessionBinding,
    RuntimeEventDisposition, RuntimeHealth, StopReason,
};

fn session() -> BrokerSession {
    BrokerSession::new(BrokerSessionId::parse("broker-1").unwrap())
}

fn ready_session() -> (BrokerSession, u64) {
    let mut session = session();
    let generation = session.begin_runtime_start().unwrap();
    session
        .mark_runtime_ready(
            generation,
            PiSessionBinding::new("pi-1", "/tmp/pi-1.jsonl", "/repo").unwrap(),
        )
        .unwrap();
    (session, generation)
}

#[test]
fn runtime_generations_increase_and_old_events_are_rejected() {
    let (mut session, first) = ready_session();
    session.runtime_exited(first, "crash").unwrap();
    let second = session.begin_runtime_start().unwrap();

    assert!(second > first);
    assert_eq!(
        session.accept_runtime_event(first),
        RuntimeEventDisposition::Stale
    );
    assert_eq!(
        session.accept_runtime_event(second),
        RuntimeEventDisposition::Current
    );
}

#[test]
fn disconnecting_a_client_does_not_cancel_foreground_work() {
    let (mut session, generation) = ready_session();
    let client = ClientId::parse("diagnostic-1").unwrap();
    let operation = OperationId::parse("operation-1").unwrap();
    session.attach(client.clone());
    let expected_revision = session.revision();
    session
        .accept_prompt(&client, expected_revision, operation.clone())
        .unwrap();

    session.detach(&client);

    assert_eq!(
        session.foreground(),
        &ForegroundState::Running {
            operation_id: operation
        }
    );
    assert_eq!(
        session.runtime_health(),
        RuntimeHealth::Ready { generation }
    );
}

#[test]
fn worker_exit_interrupts_active_work_without_replaying_it() {
    let (mut session, generation) = ready_session();
    let client = ClientId::parse("diagnostic-1").unwrap();
    session.attach(client.clone());
    session
        .accept_prompt(
            &client,
            session.revision(),
            OperationId::parse("operation-1").unwrap(),
        )
        .unwrap();

    session
        .runtime_exited(generation, "signal: SIGKILL")
        .unwrap();

    assert_eq!(
        session.foreground(),
        &ForegroundState::Idle {
            last_stop_reason: Some(StopReason::Interrupted),
        }
    );
    assert_eq!(
        session.runtime_health(),
        RuntimeHealth::Interrupted { generation }
    );
}

#[test]
fn a_second_prompt_and_a_stale_revision_are_rejected() {
    let (mut session, _) = ready_session();
    let first_client = ClientId::parse("client-1").unwrap();
    let second_client = ClientId::parse("client-2").unwrap();
    session.attach(first_client.clone());
    session.attach(second_client.clone());
    session
        .accept_prompt(
            &first_client,
            session.revision(),
            OperationId::parse("operation-1").unwrap(),
        )
        .unwrap();

    let busy = session.accept_prompt(
        &second_client,
        session.revision(),
        OperationId::parse("operation-2").unwrap(),
    );
    assert!(matches!(
        busy,
        Err(pi_tai_broker::BrokerError::ForegroundBusy)
    ));

    session
        .complete_foreground(
            session.runtime_generation(),
            &OperationId::parse("operation-1").unwrap(),
            StopReason::Completed,
        )
        .unwrap();
    let current_revision = session.revision();
    let stale = session.accept_prompt(
        &second_client,
        current_revision - 1,
        OperationId::parse("operation-2").unwrap(),
    );
    assert!(matches!(
        stale,
        Err(pi_tai_broker::BrokerError::RevisionConflict { expected, actual })
            if expected + 1 == actual && actual == current_revision
    ));
}

#[test]
fn relocation_keeps_broker_identity_and_advances_revision() {
    let (mut session, generation) = ready_session();
    let broker_id = session.id().clone();
    let revision = session.revision();

    session
        .replace_pi_session(
            generation,
            PiSessionBinding::new("pi-2", "/tmp/pi-2.jsonl", "/repo/.jj/workspaces/task").unwrap(),
        )
        .unwrap();

    assert_eq!(session.id(), &broker_id);
    assert_eq!(session.revision(), revision + 1);
    assert_eq!(session.pi_session().unwrap().pi_session_id(), "pi-2");
    assert_eq!(
        session.pi_session().unwrap().cwd(),
        "/repo/.jj/workspaces/task"
    );
}
