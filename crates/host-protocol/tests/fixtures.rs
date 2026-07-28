use std::{fs, path::PathBuf};

use pi_tai_host_protocol::{
    ClientHello, HostCommand, HostEvent, HostHello, HostProtocolError, ProtocolRange,
    negotiate_protocol,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/host-protocol")
        .join(name)
}

fn fixture<T: DeserializeOwned>(name: &str) -> T {
    let contents = fs::read_to_string(fixture_path(name)).expect("fixture should be readable");
    serde_json::from_str(&contents).expect("fixture should match the Rust contract")
}

fn assert_round_trip<T>(name: &str)
where
    T: DeserializeOwned + serde::Serialize,
{
    let original: Value = fixture(name);
    let typed: T = fixture(name);
    let encoded = serde_json::to_value(typed).expect("contract should serialize");
    assert_eq!(encoded, original);
}

#[test]
fn cross_language_envelopes_round_trip() {
    assert_round_trip::<ClientHello>("client-hello.json");
    assert_round_trip::<HostHello>("host-hello.json");
    assert_round_trip::<HostCommand>("command-prompt.json");
    assert_round_trip::<HostEvent>("event-text-delta.json");
    assert_round_trip::<HostProtocolError>("error-version-mismatch.json");
}

#[test]
fn negotiation_fixtures_select_the_highest_overlap() {
    let cases: Vec<Value> = fixture("negotiation-cases.json");
    for case in cases {
        let client: ProtocolRange =
            serde_json::from_value(case["client"].clone()).expect("valid client range");
        let host: ProtocolRange =
            serde_json::from_value(case["host"].clone()).expect("valid host range");
        let selected = case["selected"].as_u64().map(|value| value as u32);
        assert_eq!(
            negotiate_protocol(client, host).ok(),
            selected,
            "{}",
            case["name"]
        );
    }
}

#[test]
fn incompatible_ranges_report_both_sides() {
    let error = negotiate_protocol(
        ProtocolRange {
            min_version: 2,
            max_version: 3,
        },
        ProtocolRange {
            min_version: 1,
            max_version: 1,
        },
    )
    .expect_err("ranges must not overlap");

    assert_eq!(error.client_min, 2);
    assert_eq!(error.client_max, 3);
    assert_eq!(error.host_min, 1);
    assert_eq!(error.host_max, 1);
}
