use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingEffort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionConfig {
    pub enabled: bool,
    #[specta(type = i32)]
    pub threshold_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub name: String,
    pub provider: String,
    pub model: String,
    pub effort: ThinkingEffort,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPolicy {
    pub compaction: CompactionConfig,
    pub model_profiles: Vec<ModelProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnsiThemeConfig {
    pub dark_theme: String,
    pub light_theme: String,
    pub poll_interval_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationsConfig {
    pub review_failure: bool,
    pub agent_completion: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CmuxConfig {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientPreferences {
    pub ansi_theme: AnsiThemeConfig,
    pub notifications: NotificationsConfig,
    pub cmux: CmuxConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostMachineConfig {}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPiTaiConfig {
    pub session_policy: SessionPolicy,
    pub client_preferences: ClientPreferences,
    pub host_machine: HostMachineConfig,
}

pub fn default_config() -> ResolvedPiTaiConfig {
    ResolvedPiTaiConfig {
        session_policy: SessionPolicy {
            compaction: CompactionConfig {
                enabled: true,
                threshold_percent: 90.0,
            },
            model_profiles: ["low", "medium", "high"]
                .into_iter()
                .map(|effort| ModelProfile {
                    name: format!("sol-{effort}"),
                    provider: "openai-codex".into(),
                    model: "gpt-5.6-sol".into(),
                    effort: match effort {
                        "low" => ThinkingEffort::Low,
                        "medium" => ThinkingEffort::Medium,
                        _ => ThinkingEffort::High,
                    },
                })
                .collect(),
        },
        client_preferences: ClientPreferences {
            ansi_theme: AnsiThemeConfig {
                dark_theme: "ansi-dark".into(),
                light_theme: "ansi-light".into(),
                poll_interval_ms: 2000,
            },
            notifications: NotificationsConfig {
                review_failure: true,
                agent_completion: true,
            },
            cmux: CmuxConfig { enabled: true },
        },
        host_machine: HostMachineConfig {},
    }
}
