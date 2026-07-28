use pi_tai_config::{
    ConfigLayer, ConfigProvenance, ConfigScope, FieldDescriptor, FieldOrigin, SessionPolicy,
};
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;
use specta::{Type, Types};
use specta_serde::PhasesFormat as SerdeFormat;
use specta_typescript::{Number, Typescript, Unknown};
use thiserror::Error;

pub const CURRENT_RUNTIME_PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolRange {
    pub min_version: u32,
    pub max_version: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum CommandFrameKind {
    #[serde(rename = "command")]
    Command,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum ResponseFrameKind {
    #[serde(rename = "response")]
    Response,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
pub enum EventFrameKind {
    #[serde(rename = "event")]
    Event,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCommand {
    pub protocol_version: u32,
    pub kind: CommandFrameKind,
    pub id: String,
    pub method: String,
    #[specta(type = Unknown)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProtocolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<Unknown>)]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeResponse {
    pub protocol_version: u32,
    pub kind: ResponseFrameKind,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<Unknown>)]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RuntimeProtocolError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvent {
    pub protocol_version: u32,
    pub kind: EventFrameKind,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    #[specta(type = Number)]
    pub worker_sequence: u64,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    #[specta(type = Number)]
    pub runtime_generation: u64,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[specta(type = Unknown)]
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInitializeParams {
    pub protocol: ProtocolRange,
    pub worker_id: String,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    #[specta(type = Number)]
    pub runtime_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCreateParams {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_session_id: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_safe_u64",
        default
    )]
    #[specta(type = Option<Number>)]
    pub runtime_generation: Option<u64>,
    pub agent_dir: String,
    pub session_dir: String,
    pub session_policy: SessionPolicy,
    pub policy_provenance: ConfigProvenance,
    #[serde(default)]
    pub faux: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionOpenParams {
    pub session_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_session_id: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_safe_u64",
        default
    )]
    #[specta(type = Option<Number>)]
    pub runtime_generation: Option<u64>,
    pub agent_dir: String,
    pub session_dir: String,
    pub session_policy: SessionPolicy,
    pub policy_provenance: ConfigProvenance,
    #[serde(default)]
    pub faux: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionPromptParams {
    pub turn_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTextParams {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCancelParams {
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostServiceResponseParams {
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<Unknown>)]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RuntimeProtocolError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSetModelParams {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSetThinkingParams {
    pub level: ThinkingLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSetCapabilityParams {
    pub capability_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceBackend {
    Jj,
    Git,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRelocateWorkspaceParams {
    pub backend: WorkspaceBackend,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCapabilityState {
    pub id: String,
    pub available: bool,
    pub service_enabled: bool,
    pub tools_exposed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCapabilities {
    pub methods: Vec<String>,
    pub tools: Vec<String>,
    pub commands: Vec<String>,
    pub session_capabilities: Vec<SessionCapabilityState>,
    pub extension_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInitializeResult {
    pub protocol_version: u32,
    pub worker_id: String,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    #[specta(type = Number)]
    pub runtime_generation: u64,
    pub capabilities: RuntimeCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionInfo {
    pub session_id: String,
    pub session_file: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedResult {
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct EmptyResult {}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelInfo {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThinkingInfo {
    pub level: ThinkingLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDeltaData {
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolLifecycleData {
    pub tool_call_id: String,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueData {
    pub steering_count: u32,
    pub follow_up_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTitleData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterruptionData {
    pub reason: String,
}

#[derive(Debug, Error)]
pub enum BindingExportError {
    #[error("Specta TypeScript export failed: {0}")]
    Export(String),
}

fn deserialize_optional_safe_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|value| value > MAX_SAFE_INTEGER) {
        return Err(D::Error::custom(
            "value exceeds JavaScript safe integer range",
        ));
    }
    Ok(value)
}

fn deserialize_safe_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let value = u64::deserialize(deserializer)?;
    if value > MAX_SAFE_INTEGER {
        return Err(D::Error::custom(
            "value exceeds JavaScript safe integer range",
        ));
    }
    Ok(value)
}

pub fn protocol_types() -> Types {
    Types::default()
        .register::<SessionPolicy>()
        .register::<FieldOrigin>()
        .register::<ConfigLayer>()
        .register::<ConfigScope>()
        .register::<FieldDescriptor>()
        .register::<ConfigProvenance>()
        .register::<RuntimeCommand>()
        .register::<RuntimeResponse>()
        .register::<RuntimeEvent>()
        .register::<RuntimeInitializeParams>()
        .register::<SessionCreateParams>()
        .register::<SessionOpenParams>()
        .register::<SessionPromptParams>()
        .register::<SessionTextParams>()
        .register::<SessionCancelParams>()
        .register::<HostServiceResponseParams>()
        .register::<SessionSetModelParams>()
        .register::<SessionSetThinkingParams>()
        .register::<SessionSetCapabilityParams>()
        .register::<SessionRelocateWorkspaceParams>()
        .register::<EmptyParams>()
        .register::<SessionCapabilityState>()
        .register::<RuntimeInitializeResult>()
        .register::<SessionInfo>()
        .register::<AcceptedResult>()
        .register::<EmptyResult>()
        .register::<ModelInfo>()
        .register::<ThinkingInfo>()
        .register::<TextDeltaData>()
        .register::<ToolLifecycleData>()
        .register::<QueueData>()
        .register::<SessionTitleData>()
        .register::<InterruptionData>()
}

pub fn generate_typescript_bindings() -> Result<String, BindingExportError> {
    Typescript::new()
        .header("// @generated by pi-tai-runtime-protocol. Do not edit.\n")
        .export(&protocol_types(), SerdeFormat)
        .map_err(|error| BindingExportError::Export(error.to_string()))
}
