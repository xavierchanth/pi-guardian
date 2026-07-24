use pi_tai_event_store::{
    AppendOutcome, EventStore, OperationCommit, SessionProjection, StoreError, UsageEntry,
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
fn usage_entries_are_exact_idempotent_and_report_telemetry_gaps() {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = EventStore::open(temporary.path().join("broker.sqlite3")).unwrap();
    store.append(&projection(1), &event(1, 1, "session.created"), None).unwrap();
    let usage = UsageEntry {
        usage_event_id: "usage-1".into(), session_id: "session-1".into(), context_id: "child-1".into(), cycle_id: "cycle-1".into(), message_id: "message-1".into(), provider: "provider".into(), model: "model".into(), role: "worker".into(),
        input: 2, output: 3, cache_read: 4, cache_write: 5, cost_input: 0.1, cost_output: 0.2, cost_cache_read: 0.3, cost_cache_write: 0.4, cost_total: 1.0, recorded_at: "now".into(),
    };
    assert!(store.record_usage(&usage).unwrap());
    assert!(!store.record_usage(&usage).unwrap());
    assert!(store.record_usage_gap("gap-1", "session-1", "child-2", "cycle-2", "missing_message_usage", "now").unwrap());
    let totals = store.usage_totals("session-1").unwrap();
    assert_eq!((totals.input, totals.output, totals.cache_read, totals.cache_write, totals.cost, totals.telemetry_gap_count), (2, 3, 4, 5, 1.0, 1));
    let breakdown = store.usage_breakdown("session-1").unwrap();
    assert_eq!(breakdown.by_model["provider/model"].output, 3);
    assert_eq!(breakdown.by_role["worker"].input, 2);
    assert_eq!(breakdown.by_context["child-1"].cache_read, 4);
    assert_eq!(breakdown.by_execution_cycle["cycle-1"].cache_write, 5);
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
