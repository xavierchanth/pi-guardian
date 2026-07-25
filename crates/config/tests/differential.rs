use pi_tai_config::{ConfigDocument, ConfigLayer, ProjectTrust, resolve};
use serde_json::Value;
use std::{fs, path::Path};

#[test]
fn rust_resolver_matches_shared_fixture_corpus() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/config");
    let mut cases = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    cases.sort();
    for case in cases {
        if !case.is_dir() {
            continue;
        }
        let metadata: Value =
            serde_json::from_str(&fs::read_to_string(case.join("metadata.json")).unwrap()).unwrap();
        let mut layers = Vec::new();
        add_layer(
            &mut layers,
            &case.join("global.json"),
            ConfigLayer::User,
            "global.json",
        );
        add_layer(
            &mut layers,
            &case.join("project.json"),
            ConfigLayer::Project,
            "project.json",
        );
        let actual = serde_json::to_value(resolve(
            &layers,
            &ProjectTrust {
                trusted: metadata["projectTrusted"].as_bool().unwrap(),
            },
        ))
        .unwrap();
        let expected: Value =
            serde_json::from_str(&fs::read_to_string(case.join("expected.json")).unwrap()).unwrap();
        assert_json_equivalent(
            &actual,
            &expected,
            &case.file_name().unwrap().to_string_lossy(),
        );
    }
}

fn assert_json_equivalent(actual: &Value, expected: &Value, case: &str) {
    match (actual, expected) {
        (Value::Number(left), Value::Number(right)) => {
            assert_eq!(left.as_f64(), right.as_f64(), "fixture {case}")
        }
        (Value::Array(left), Value::Array(right)) => {
            assert_eq!(left.len(), right.len(), "fixture {case}");
            for (left, right) in left.iter().zip(right) {
                assert_json_equivalent(left, right, case);
            }
        }
        (Value::Object(left), Value::Object(right)) => {
            assert_eq!(
                left.keys().collect::<Vec<_>>(),
                right.keys().collect::<Vec<_>>(),
                "fixture {case}"
            );
            for (key, left) in left {
                assert_json_equivalent(left, &right[key], case);
            }
        }
        _ => assert_eq!(actual, expected, "fixture {case}"),
    }
}

fn add_layer(layers: &mut Vec<ConfigDocument>, path: &Path, layer: ConfigLayer, label: &str) {
    if let Ok(raw) = fs::read_to_string(path) {
        layers.push(ConfigDocument::new(layer, label, raw));
    }
}
