use std::{fs, path::PathBuf};

use pi_tai_runtime_protocol::{
    RuntimeCommand, RuntimeEvent, RuntimeInitializeParams, RuntimeResponse,
    generate_typescript_bindings,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/runtime-protocol")
        .join(name)
}

fn fixture<T: DeserializeOwned>(name: &str) -> T {
    let contents = fs::read_to_string(fixture_path(name)).expect("fixture should be readable");
    serde_json::from_str(&contents).expect("fixture should match Rust protocol DTO")
}

#[test]
fn serde_consumes_shared_runtime_fixtures() {
    let command: RuntimeCommand = fixture("initialize-command.json");
    let params: RuntimeInitializeParams =
        serde_json::from_value(command.params.clone()).expect("known params should decode");
    let response: RuntimeResponse = fixture("initialize-response.json");
    let event: RuntimeEvent = fixture("text-delta-event.json");

    assert_eq!(params.worker_id, "worker-1");
    assert!(response.ok);
    assert_eq!(event.worker_sequence, 4);
}

#[test]
fn serde_rejects_unknown_fields_and_unsafe_json_integers() {
    let extra: Value = fixture("invalid-extra-field.json");
    assert!(serde_json::from_value::<RuntimeCommand>(extra).is_err());

    let unsafe_sequence: Value = fixture("invalid-unsafe-sequence.json");
    assert!(serde_json::from_value::<RuntimeEvent>(unsafe_sequence).is_err());
}

#[test]
fn generated_typescript_bindings_are_current_and_json_values_are_unknown() {
    let generated = generate_typescript_bindings().expect("bindings should export");
    let checked_in = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/runtime-protocol/src/generated.ts"),
    )
    .expect("checked-in bindings should exist");

    assert_eq!(generated, checked_in);
    assert!(generated.contains("params: unknown"));
    assert!(!generated.contains("Object: Record"));
}
