use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const CURRENT_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolRange {
    pub min_version: u32,
    pub max_version: u32,
}

impl ProtocolRange {
    pub fn current() -> Self {
        Self {
            min_version: CURRENT_PROTOCOL_VERSION,
            max_version: CURRENT_PROTOCOL_VERSION,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClientKind {
    Acp,
    Diagnostic,
    Desktop,
    Mobile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol: ProtocolRange,
    pub implementation: ImplementationInfo,
    pub client_kind: ClientKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostHello {
    pub protocol_version: u32,
    pub implementation: ImplementationInfo,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostCommand<T = Value> {
    pub protocol_version: u32,
    pub request_id: String,
    pub operation_id: String,
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    pub kind: String,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostEvent<T = Value> {
    pub protocol_version: u32,
    pub session_id: String,
    pub sequence: u64,
    pub revision: u64,
    pub runtime_generation: u64,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostProtocolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error(
    "incompatible protocol ranges: client {client_min}-{client_max}, host {host_min}-{host_max}"
)]
pub struct NegotiationError {
    pub client_min: u32,
    pub client_max: u32,
    pub host_min: u32,
    pub host_max: u32,
}

pub fn negotiate_protocol(
    client: ProtocolRange,
    host: ProtocolRange,
) -> Result<u32, NegotiationError> {
    let minimum = client.min_version.max(host.min_version);
    let maximum = client.max_version.min(host.max_version);
    if minimum <= maximum {
        return Ok(maximum);
    }
    Err(NegotiationError {
        client_min: client.min_version,
        client_max: client.max_version,
        host_min: host.min_version,
        host_max: host.max_version,
    })
}
