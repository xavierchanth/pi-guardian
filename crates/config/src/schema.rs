use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TitleEffort {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

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

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitleConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub effort: TitleEffort,
    pub max_words: u32,
    pub fallback: String,
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
    pub session_title: SessionTitleConfig,
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
pub struct ClientPreferences {
    pub ansi_theme: AnsiThemeConfig,
    pub notifications: NotificationsConfig,
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
            session_title: SessionTitleConfig {
                provider: None,
                model: None,
                effort: TitleEffort::Minimal,
                max_words: 6,
                fallback: "heuristic".into(),
            },
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
        },
        host_machine: HostMachineConfig {},
    }
}
