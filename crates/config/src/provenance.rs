use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigLayer {
    Default,
    Machine,
    User,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldOrigin {
    pub layer: ConfigLayer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigScope {
    Machine,
    Project,
    Session,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldDescriptor {
    pub scope: ConfigScope,
    pub privileged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(transparent)]
pub struct ConfigProvenance(pub BTreeMap<String, FieldOrigin>);

impl std::ops::Deref for ConfigProvenance {
    type Target = BTreeMap<String, FieldOrigin>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for ConfigProvenance {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
