use pi_tai_event_store::{
    AppendOutcome, EventStore, OperationCommit, SessionProjection, StoreError,
};
use pi_tai_host_protocol::{CURRENT_PROTOCOL_VERSION, HostEvent};
use serde_json::json;

fn projection(revision: u64) -> SessionProjection {
    SessionProjection {
        session_id: "session-1".into(),
        revision,
        runtime_generation: 1,
        snapshot: json!({ "sessionId": "session-1", "revision": revision }),
    }
}

fn event(sequence: u64, revision: u64, event_type: &str) -> HostEvent {
    HostEvent {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        session_id: "session-1".into(),
        sequence,
        revision,
        runtime_generation: 1,
        timestamp: "2026-07-22T00:00:00Z".into(),
        event_type: event_type.into(),
        payload: json!({ "sequence": sequence }),
    }
}

fn operation() -> OperationCommit {
    OperationCommit {
        operation_id: "operation-1".into(),
        session_id: "session-1".into(),
        kind: "session.prompt".into(),
        expected_revision: Some(0),
        response: json!({ "accepted": true }),
    }
}

#[test]
fn commits_projection_event_and_operation_atomically_then_reopens() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("broker.sqlite3");
    {
        let mut store = EventStore::open(&path).unwrap();
        assert_eq!(store.journal_mode().unwrap(), "wal");
        assert_eq!(
            store
                .append(
                    &projection(1),
                    &event(1, 1, "foreground.running"),
                    Some(&operation())
                )
                .unwrap(),
            AppendOutcome::Committed
        );
    }

    let store = EventStore::open(&path).unwrap();
    assert_eq!(
        store.load_projection("session-1").unwrap(),
        Some(projection(1))
    );
    assert_eq!(store.list_projections().unwrap(), vec![projection(1)]);
    assert_eq!(store.last_sequence("session-1").unwrap(), 1);
    assert_eq!(
        store.events_after("session-1", 0, 10).unwrap(),
        vec![event(1, 1, "foreground.running")]
    );
    assert_eq!(
        store.operation_response("operation-1").unwrap(),
        Some(json!({ "accepted": true }))
    );
}

#[test]
fn duplicate_operation_returns_the_original_response_without_an_event() {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = EventStore::open(temporary.path().join("broker.sqlite3")).unwrap();
    let operation = operation();
    store
        .append(
            &projection(1),
            &event(1, 1, "foreground.running"),
            Some(&operation),
        )
        .unwrap();

    let duplicate = store
        .append(
            &projection(2),
            &event(2, 2, "should.not.exist"),
            Some(&operation),
        )
        .unwrap();
    assert_eq!(
        duplicate,
        AppendOutcome::Duplicate {
            response: json!({ "accepted": true })
        }
    );
    assert_eq!(store.events_after("session-1", 0, 10).unwrap().len(), 1);
    assert_eq!(
        store.load_projection("session-1").unwrap(),
        Some(projection(1))
    );
}

#[test]
fn rejects_sequence_gaps_revision_regressions_and_operation_collisions() {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = EventStore::open(temporary.path().join("broker.sqlite3")).unwrap();
    store
        .append(&projection(2), &event(1, 2, "session.created"), None)
        .unwrap();

    assert!(matches!(
        store.append(&projection(3), &event(3, 3, "gap"), None),
        Err(StoreError::SequenceConflict {
            expected: 2,
            actual: 3
        })
    ));
    assert!(matches!(
        store.append(&projection(1), &event(2, 1, "regression"), None),
        Err(StoreError::RevisionRegression {
            current: 2,
            incoming: 1
        })
    ));

    let first = operation();
    store
        .append(&projection(3), &event(2, 3, "accepted"), Some(&first))
        .unwrap();
    let mut collision = first;
    collision.kind = "session.cancel".into();
    assert!(matches!(
        store.append(&projection(4), &event(3, 4, "collision"), Some(&collision)),
        Err(StoreError::OperationCollision(id)) if id == "operation-1"
    ));
}
