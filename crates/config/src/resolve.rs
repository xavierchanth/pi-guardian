use crate::{
    descriptors::FIELD_DESCRIPTORS,
    provenance::{ConfigLayer, ConfigProvenance, FieldOrigin},
    schema::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub layer: ConfigLayer,
    pub path: String,
    pub raw: String,
    pub digest: String,
}
impl ConfigDocument {
    pub fn new(layer: ConfigLayer, path: impl Into<String>, raw: impl Into<String>) -> Self {
        let raw = raw.into();
        let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
        Self {
            layer,
            path: path.into(),
            raw,
            digest,
        }
    }
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrust {
    pub trusted: bool,
}
pub type Warning = String;
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub config: ResolvedPiTaiConfig,
    pub provenance: ConfigProvenance,
    pub warnings: Vec<Warning>,
}

pub fn resolve(layers: &[ConfigDocument], trust: &ProjectTrust) -> Resolution {
    let mut warnings = Vec::new();
    let mut parsed = Vec::new();
    for layer in layers {
        if layer.layer == ConfigLayer::Project && !trust.trusted {
            continue;
        }
        if let Some(values) = parse_layer(layer, &mut warnings) {
            parsed.push((layer, values));
        }
    }
    let mut config = default_config();
    let mut provenance = ConfigProvenance(
        FIELD_DESCRIPTORS
            .iter()
            .map(|(path, _)| {
                (
                    (*path).into(),
                    FieldOrigin {
                        layer: ConfigLayer::Default,
                        path: None,
                        digest: None,
                    },
                )
            })
            .collect(),
    );
    for (layer, values) in parsed {
        apply(&mut config, &mut provenance, layer, values);
    }
    Resolution {
        config,
        provenance,
        warnings,
    }
}

fn parse_layer(
    layer: &ConfigDocument,
    warnings: &mut Vec<String>,
) -> Option<BTreeMap<String, Value>> {
    let mut root: Value = match serde_json::from_str(&layer.raw) {
        Ok(value) => value,
        Err(error) => {
            let message = if layer.raw == "{" {
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)".into()
            } else {
                error.to_string()
            };
            warnings.push(format!("Invalid or unreadable {}: {message}", layer.path));
            return None;
        }
    };
    let Some(object) = root.as_object_mut() else {
        warnings.push(format!("Invalid {}: expected a JSON object.", layer.path));
        return None;
    };
    if layer.layer == ConfigLayer::Project {
        reject_privileged(object, &layer.path, warnings);
    }
    for key in object.keys() {
        if ![
            "sessionTitle",
            "ansiTheme",
            "notifications",
            "cmux",
            "compaction",
            "modelProfiles",
        ]
        .contains(&key.as_str())
        {
            warnings.push(format!("Unknown top-level key {key} in {}.", layer.path));
        }
    }
    let mut result = BTreeMap::new();
    parse_session_title(
        object.get("sessionTitle"),
        &layer.path,
        warnings,
        &mut result,
    );
    parse_ansi_theme(object.get("ansiTheme"), &layer.path, warnings, &mut result);
    parse_notifications(
        object.get("notifications"),
        &layer.path,
        warnings,
        &mut result,
    );
    parse_cmux(object.get("cmux"), &layer.path, warnings, &mut result);
    parse_compaction(object.get("compaction"), &layer.path, warnings, &mut result);
    parse_profiles(
        object.get("modelProfiles"),
        &layer.path,
        warnings,
        &mut result,
    );
    Some(result)
}

fn reject_privileged(root: &mut Map<String, Value>, path: &str, warnings: &mut Vec<String>) {
    for (dotted, descriptor) in FIELD_DESCRIPTORS {
        if !descriptor.privileged {
            continue;
        }
        let raw = dotted
            .strip_prefix("sessionPolicy.")
            .or_else(|| dotted.strip_prefix("clientPreferences."))
            .unwrap_or(dotted);
        let mut parts: Vec<_> = raw.split('.').collect();
        let key = parts.pop().unwrap();
        if remove_nested(root, &parts, key) {
            warnings.push(format!("Ignored privileged {dotted} from {path}: privileged fields cannot be set by a project."));
        }
    }
}
fn remove_nested(owner: &mut Map<String, Value>, path: &[&str], key: &str) -> bool {
    match path.split_first() {
        None => owner.remove(key).is_some(),
        Some((head, tail)) => owner
            .get_mut(*head)
            .and_then(Value::as_object_mut)
            .is_some_and(|next| remove_nested(next, tail, key)),
    }
}
fn object<'a>(
    value: Option<&'a Value>,
    name: &str,
    path: &str,
    warnings: &mut Vec<String>,
) -> Option<&'a Map<String, Value>> {
    let value = value?;
    match value.as_object() {
        Some(value) => Some(value),
        None => {
            warnings.push(format!("Invalid {name} in {path}: expected an object."));
            None
        }
    }
}
fn unknowns(
    value: &Map<String, Value>,
    allowed: &[&str],
    prefix: &str,
    path: &str,
    warnings: &mut Vec<String>,
) {
    for key in value.keys() {
        if !allowed.contains(&key.as_str()) {
            warnings.push(format!("Unknown {prefix}.{key} in {path}."));
        }
    }
}
fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(Into::into)
}
fn put(out: &mut BTreeMap<String, Value>, path: &str, value: impl Into<Value>) {
    out.insert(path.into(), value.into());
}

fn parse_session_title(
    value: Option<&Value>,
    path: &str,
    warnings: &mut Vec<String>,
    out: &mut BTreeMap<String, Value>,
) {
    let Some(v) = object(value, "sessionTitle", path, warnings) else {
        return;
    };
    unknowns(
        v,
        &["provider", "model", "effort", "maxWords", "fallback"],
        "sessionTitle",
        path,
        warnings,
    );
    for key in ["provider", "model"] {
        if let Some(value) = v.get(key) {
            if let Some(s) = string(value) {
                put(out, &format!("sessionPolicy.sessionTitle.{key}"), s);
            } else {
                warnings.push(format!(
                    "Invalid {key} in {path}: expected a non-empty string."
                ));
            }
        }
    }
    if let Some(value) = v.get("effort") {
        if value
            .as_str()
            .is_some_and(|v| ["minimal", "low", "medium", "high", "xhigh", "max"].contains(&v))
        {
            put(out, "sessionPolicy.sessionTitle.effort", value.clone());
        } else {
            warnings.push(format!("Invalid sessionTitle.effort in {path}."));
        }
    }
    if let Some(value) = v.get("maxWords") {
        if let Some(number) = json_u64(value).filter(|v| (1..=20).contains(v)) {
            put(out, "sessionPolicy.sessionTitle.maxWords", number);
        } else {
            warnings.push(format!(
                "Invalid sessionTitle.maxWords in {path}: expected an integer from 1 to 20."
            ));
        }
    }
    if let Some(value) = v.get("fallback") {
        if value == "heuristic" {
            put(out, "sessionPolicy.sessionTitle.fallback", value.clone());
        } else {
            warnings.push(format!(
                "Invalid sessionTitle.fallback in {path}: expected heuristic."
            ));
        }
    }
}
fn parse_ansi_theme(
    value: Option<&Value>,
    path: &str,
    warnings: &mut Vec<String>,
    out: &mut BTreeMap<String, Value>,
) {
    let Some(v) = object(value, "ansiTheme", path, warnings) else {
        return;
    };
    unknowns(
        v,
        &["darkTheme", "lightTheme", "pollIntervalMs"],
        "ansiTheme",
        path,
        warnings,
    );
    for key in ["darkTheme", "lightTheme"] {
        if let Some(value) = v.get(key) {
            if let Some(s) = string(value) {
                put(out, &format!("clientPreferences.ansiTheme.{key}"), s)
            } else {
                warnings.push(format!(
                    "Invalid {key} in {path}: expected a non-empty string."
                ))
            }
        }
    }
    if let Some(value) = v.get("pollIntervalMs") {
        if let Some(number) = json_u64(value).filter(|v| (250..=60000).contains(v)) {
            put(out, "clientPreferences.ansiTheme.pollIntervalMs", number)
        } else {
            warnings.push(format!(
                "Invalid ansiTheme.pollIntervalMs in {path}: expected an integer from 250 to 60000."
            ))
        }
    }
}
fn json_u64(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite() && number >= 0.0 && number.fract() == 0.0).then_some(number as u64)
}
fn parse_notifications(
    value: Option<&Value>,
    path: &str,
    warnings: &mut Vec<String>,
    out: &mut BTreeMap<String, Value>,
) {
    let Some(v) = object(value, "notifications", path, warnings) else {
        return;
    };
    unknowns(
        v,
        &["reviewFailure", "agentCompletion"],
        "notifications",
        path,
        warnings,
    );
    for key in ["reviewFailure", "agentCompletion"] {
        if let Some(value) = v.get(key) {
            if value.is_boolean() {
                put(
                    out,
                    &format!("clientPreferences.notifications.{key}"),
                    value.clone(),
                )
            } else {
                warnings.push(format!(
                    "Invalid notifications.{key} in {path}: expected a boolean."
                ))
            }
        }
    }
}
fn parse_cmux(
    value: Option<&Value>,
    path: &str,
    warnings: &mut Vec<String>,
    out: &mut BTreeMap<String, Value>,
) {
    let Some(v) = object(value, "cmux", path, warnings) else {
        return;
    };
    unknowns(v, &["enabled"], "cmux", path, warnings);
    if let Some(value) = v.get("enabled") {
        if value.is_boolean() {
            put(out, "clientPreferences.cmux.enabled", value.clone())
        } else {
            warnings.push(format!(
                "Invalid cmux.enabled in {path}: expected a boolean."
            ))
        }
    }
}
fn parse_compaction(
    value: Option<&Value>,
    path: &str,
    warnings: &mut Vec<String>,
    out: &mut BTreeMap<String, Value>,
) {
    let Some(v) = object(value, "compaction", path, warnings) else {
        return;
    };
    unknowns(
        v,
        &["enabled", "thresholdPercent"],
        "compaction",
        path,
        warnings,
    );
    if let Some(value) = v.get("enabled") {
        if value.is_boolean() {
            put(out, "sessionPolicy.compaction.enabled", value.clone())
        } else {
            warnings.push(format!(
                "Invalid compaction.enabled in {path}: expected a boolean."
            ))
        }
    }
    if let Some(value) = v.get("thresholdPercent") {
        if value
            .as_f64()
            .is_some_and(|v| v.is_finite() && (1.0..=100.0).contains(&v))
        {
            put(
                out,
                "sessionPolicy.compaction.thresholdPercent",
                value.clone(),
            )
        } else {
            warnings.push(format!(
                "Invalid compaction.thresholdPercent in {path}: expected a number from 1 to 100."
            ))
        }
    }
}
fn parse_profiles(
    value: Option<&Value>,
    path: &str,
    warnings: &mut Vec<String>,
    out: &mut BTreeMap<String, Value>,
) {
    let Some(value) = value else { return };
    let Some(items) = value.as_array() else {
        warnings.push(format!(
            "Invalid modelProfiles in {path}: expected an array."
        ));
        return;
    };
    let mut names = BTreeSet::new();
    let mut profiles = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(v) = item.as_object() else {
            warnings.push(format!(
                "Invalid modelProfiles[{index}] in {path}: expected an object."
            ));
            return;
        };
        unknowns(
            v,
            &["name", "provider", "model", "effort"],
            &format!("modelProfiles[{index}]"),
            path,
            warnings,
        );
        let name = v.get("name").and_then(string);
        let provider = v.get("provider").and_then(string);
        let model = v.get("model").and_then(string);
        let effort = v.get("effort").and_then(Value::as_str);
        if name.as_ref().is_none_or(|n| !valid_name(n)) {
            warnings.push(format!("Invalid modelProfiles[{index}].name in {path}."));
            return;
        }
        let name = name.unwrap();
        if !names.insert(name.clone()) {
            warnings.push(format!("Duplicate model profile \"{name}\" in {path}."));
            return;
        }
        if provider.is_none() || model.is_none() {
            warnings.push(format!("Invalid modelProfiles[{index}] model in {path}."));
            return;
        }
        if effort.is_none_or(|v| {
            !["off", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&v)
        }) {
            warnings.push(format!("Invalid modelProfiles[{index}].effort in {path}."));
            return;
        }
        profiles.push(serde_json::json!({"name":name,"provider":provider.unwrap(),"model":model.unwrap(),"effort":effort.unwrap()}));
    }
    put(out, "sessionPolicy.modelProfiles", profiles)
}
fn valid_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some('a'..='z'))
        && s.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn apply(
    config: &mut ResolvedPiTaiConfig,
    provenance: &mut ConfigProvenance,
    layer: &ConfigDocument,
    values: BTreeMap<String, Value>,
) {
    for (path, value) in values {
        match path.as_str() {
            "sessionPolicy.sessionTitle.provider" => {
                config.session_policy.session_title.provider = serde_json::from_value(value).ok()
            }
            "sessionPolicy.sessionTitle.model" => {
                config.session_policy.session_title.model = serde_json::from_value(value).ok()
            }
            "sessionPolicy.sessionTitle.effort" => {
                config.session_policy.session_title.effort = serde_json::from_value(value).unwrap()
            }
            "sessionPolicy.sessionTitle.maxWords" => {
                config.session_policy.session_title.max_words =
                    serde_json::from_value(value).unwrap()
            }
            "sessionPolicy.sessionTitle.fallback" => {
                config.session_policy.session_title.fallback =
                    serde_json::from_value(value).unwrap()
            }
            "sessionPolicy.compaction.enabled" => {
                config.session_policy.compaction.enabled = serde_json::from_value(value).unwrap()
            }
            "sessionPolicy.compaction.thresholdPercent" => {
                config.session_policy.compaction.threshold_percent =
                    serde_json::from_value(value).unwrap()
            }
            "sessionPolicy.modelProfiles" => {
                config.session_policy.model_profiles = serde_json::from_value(value).unwrap()
            }
            "clientPreferences.ansiTheme.darkTheme" => {
                config.client_preferences.ansi_theme.dark_theme =
                    serde_json::from_value(value).unwrap()
            }
            "clientPreferences.ansiTheme.lightTheme" => {
                config.client_preferences.ansi_theme.light_theme =
                    serde_json::from_value(value).unwrap()
            }
            "clientPreferences.ansiTheme.pollIntervalMs" => {
                config.client_preferences.ansi_theme.poll_interval_ms =
                    serde_json::from_value(value).unwrap()
            }
            "clientPreferences.notifications.reviewFailure" => {
                config.client_preferences.notifications.review_failure =
                    serde_json::from_value(value).unwrap()
            }
            "clientPreferences.notifications.agentCompletion" => {
                config.client_preferences.notifications.agent_completion =
                    serde_json::from_value(value).unwrap()
            }
            "clientPreferences.cmux.enabled" => {
                config.client_preferences.cmux.enabled = serde_json::from_value(value).unwrap()
            }
            _ => {}
        }
        provenance.insert(
            path,
            FieldOrigin {
                layer: layer.layer,
                path: Some(layer.path.clone()),
                digest: Some(layer.digest.clone()),
            },
        );
    }
}
