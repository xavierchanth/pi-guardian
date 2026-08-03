use crate::provenance::{ConfigScope, FieldDescriptor};

pub const FIELD_DESCRIPTORS: &[(&str, FieldDescriptor)] = &[
    (
        "sessionPolicy.compaction.enabled",
        FieldDescriptor {
            scope: ConfigScope::Session,
            privileged: false,
        },
    ),
    (
        "sessionPolicy.compaction.thresholdPercent",
        FieldDescriptor {
            scope: ConfigScope::Session,
            privileged: false,
        },
    ),
    (
        "sessionPolicy.modelProfiles",
        FieldDescriptor {
            scope: ConfigScope::Session,
            privileged: true,
        },
    ),
    (
        "clientPreferences.ansiTheme.darkTheme",
        FieldDescriptor {
            scope: ConfigScope::Project,
            privileged: false,
        },
    ),
    (
        "clientPreferences.ansiTheme.lightTheme",
        FieldDescriptor {
            scope: ConfigScope::Project,
            privileged: false,
        },
    ),
    (
        "clientPreferences.ansiTheme.pollIntervalMs",
        FieldDescriptor {
            scope: ConfigScope::Project,
            privileged: false,
        },
    ),
    (
        "clientPreferences.notifications.reviewFailure",
        FieldDescriptor {
            scope: ConfigScope::Project,
            privileged: false,
        },
    ),
    (
        "clientPreferences.notifications.agentCompletion",
        FieldDescriptor {
            scope: ConfigScope::Project,
            privileged: false,
        },
    ),
    (
        "clientPreferences.cmux.enabled",
        FieldDescriptor {
            scope: ConfigScope::Project,
            privileged: false,
        },
    ),
];
