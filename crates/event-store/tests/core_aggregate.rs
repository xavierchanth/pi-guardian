use pi_tai_event_store::{CoreAppendOutcome, CoreEvent, CoreTransaction, EventStore, StoreError};
use serde_json::json;
use tempfile::tempdir;

#[test]
fn core_transactions_are_atomic_revision_checked_and_idempotent() {
    let root = tempdir().unwrap();
    let mut store = EventStore::open(root.path().join("host.db")).unwrap();
    let first = CoreTransaction {
        transaction_id: "transaction-1".into(),
        aggregate_id: "session:one:concurrency".into(),
        expected_revision: 0,
        runtime_generation: 1,
        timestamp: "2026-01-01T00:00:00Z".into(),
        events: vec![CoreEvent { event_id: "event-1".into(), event_type: "child.created".into(), payload: json!({"contextId":"child-1"}) }],
        state: json!({"contexts":[{"contextId":"child-1","sessionFile":"private"}]}),
        projection: json!({"version":1,"revision":1}),
    };
    let committed = store.append_core_transaction(&first).unwrap();
    assert!(matches!(committed, CoreAppendOutcome::Committed { .. }));
    let duplicate = store.append_core_transaction(&first).unwrap();
    assert!(matches!(duplicate, CoreAppendOutcome::Duplicate { .. }));
    assert_eq!(store.load_core_aggregate(&first.aggregate_id).unwrap().unwrap().revision, 1);
    assert_eq!(store.core_events_after(&first.aggregate_id, 0, 10).unwrap()[0].1.event_id, "event-1");

    let stale = CoreTransaction { transaction_id: "transaction-2".into(), events: vec![CoreEvent { event_id: "event-2".into(), event_type: "child.running".into(), payload: json!({}) }], ..first };
    assert!(matches!(store.append_core_transaction(&stale), Err(StoreError::CoreRevisionConflict { expected: 0, actual: 1 })));
}

#[test]
fn core_transactions_reject_empty_event_batches() {
    let root = tempdir().unwrap();
    let mut store = EventStore::open(root.path().join("host.db")).unwrap();
    let invalid = CoreTransaction { transaction_id: "transaction-1".into(), aggregate_id: "aggregate-1".into(), expected_revision: 0, runtime_generation: 1, timestamp: "now".into(), events: vec![], state: json!({}), projection: json!({}) };
    assert!(matches!(store.append_core_transaction(&invalid), Err(StoreError::InvalidCoreTransaction(_))));
}
