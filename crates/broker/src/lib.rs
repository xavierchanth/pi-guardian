use std::collections::BTreeSet;

use thiserror::Error;
use uuid::Uuid;

macro_rules! semantic_id {
    ($name:ident, $label:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::now_v7().to_string())
            }

            pub fn parse(value: impl Into<String>) -> Result<Self, BrokerError> {
                let value = value.into();
                if value.is_empty()
                    || value.len() > 128
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
                {
                    return Err(BrokerError::InvalidIdentifier {
                        kind: $label,
                        value,
                    });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
    };
}

semantic_id!(BrokerSessionId, "broker session");
semantic_id!(ClientId, "client");
semantic_id!(OperationId, "operation");
semantic_id!(InteractionId, "interaction");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiSessionBinding {
    pi_session_id: String,
    session_file: String,
    cwd: String,
}

impl PiSessionBinding {
    pub fn new(
        pi_session_id: impl Into<String>,
        session_file: impl Into<String>,
        cwd: impl Into<String>,
    ) -> Result<Self, BrokerError> {
        let pi_session_id = non_empty("Pi session ID", pi_session_id.into())?;
        let session_file = non_empty("Pi session file", session_file.into())?;
        let cwd = non_empty("Pi session cwd", cwd.into())?;
        Ok(Self {
            pi_session_id,
            session_file,
            cwd,
        })
    }

    pub fn pi_session_id(&self) -> &str {
        &self.pi_session_id
    }

    pub fn session_file(&self) -> &str {
        &self.session_file
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeHealth {
    Unloaded,
    Starting { generation: u64 },
    Ready { generation: u64 },
    Interrupted { generation: u64 },
    Failed { generation: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForegroundState {
    Idle {
        last_stop_reason: Option<StopReason>,
    },
    Running {
        operation_id: OperationId,
    },
    RequiresAction {
        operation_id: OperationId,
        interaction_id: InteractionId,
    },
}

impl ForegroundState {
    pub fn is_idle(&self) -> bool {
        matches!(self, Self::Idle { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Completed,
    Cancelled,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeEventDisposition {
    Current,
    Stale,
}

#[derive(Debug, Clone)]
pub struct BrokerRecovery {
    pub id: BrokerSessionId,
    pub revision: u64,
    pub runtime_generation: u64,
    pub pi_session: PiSessionBinding,
    pub interrupted_foreground: bool,
    pub last_stop_reason: Option<StopReason>,
    pub active_client: Option<ClientId>,
    pub control_epoch: u64,
}

#[derive(Debug, Clone)]
pub struct BrokerSession {
    id: BrokerSessionId,
    revision: u64,
    runtime_generation: u64,
    runtime_health: RuntimeHealth,
    foreground: ForegroundState,
    pi_session: Option<PiSessionBinding>,
    attachments: BTreeSet<ClientId>,
    active_client: Option<ClientId>,
    control_epoch: u64,
}

impl BrokerSession {
    pub fn new(id: BrokerSessionId) -> Self {
        Self {
            id,
            revision: 0,
            runtime_generation: 0,
            runtime_health: RuntimeHealth::Unloaded,
            foreground: ForegroundState::Idle {
                last_stop_reason: None,
            },
            pi_session: None,
            attachments: BTreeSet::new(),
            active_client: None,
            control_epoch: 0,
        }
    }

    pub fn recover(recovery: BrokerRecovery) -> Result<Self, BrokerError> {
        if recovery.runtime_generation == 0
            || (recovery.active_client.is_some() && recovery.control_epoch == 0)
            || (recovery.active_client.is_none() && recovery.control_epoch > 0)
        {
            return Err(BrokerError::InvalidRecoveryState);
        }
        Ok(Self {
            id: recovery.id,
            revision: recovery.revision,
            runtime_generation: recovery.runtime_generation,
            runtime_health: if recovery.interrupted_foreground {
                RuntimeHealth::Interrupted {
                    generation: recovery.runtime_generation,
                }
            } else {
                RuntimeHealth::Unloaded
            },
            foreground: ForegroundState::Idle {
                last_stop_reason: if recovery.interrupted_foreground {
                    Some(StopReason::Interrupted)
                } else {
                    recovery.last_stop_reason
                },
            },
            pi_session: Some(recovery.pi_session),
            attachments: BTreeSet::new(),
            active_client: recovery.active_client,
            control_epoch: recovery.control_epoch,
        })
    }

    pub fn id(&self) -> &BrokerSessionId {
        &self.id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn runtime_generation(&self) -> u64 {
        self.runtime_generation
    }

    pub fn runtime_health(&self) -> RuntimeHealth {
        self.runtime_health
    }

    pub fn foreground(&self) -> &ForegroundState {
        &self.foreground
    }

    pub fn pi_session(&self) -> Option<&PiSessionBinding> {
        self.pi_session.as_ref()
    }

    pub fn active_client(&self) -> Option<&ClientId> {
        self.active_client.as_ref()
    }

    pub fn control_epoch(&self) -> u64 {
        self.control_epoch
    }

    pub fn attachment_count(&self) -> usize {
        self.attachments.len()
    }

    pub fn is_attached(&self, client_id: &ClientId) -> bool {
        self.attachments.contains(client_id)
    }

    pub fn attach(&mut self, client_id: ClientId) {
        if self.attachments.insert(client_id) {
            self.advance_revision();
        }
    }

    pub fn detach(&mut self, client_id: &ClientId) {
        if self.attachments.remove(client_id) {
            self.advance_revision();
        }
    }

    pub fn begin_runtime_start(&mut self) -> Result<u64, BrokerError> {
        if !self.foreground.is_idle() {
            return Err(BrokerError::ForegroundBusy);
        }
        if matches!(
            self.runtime_health,
            RuntimeHealth::Starting { .. } | RuntimeHealth::Ready { .. }
        ) {
            return Err(BrokerError::RuntimeAlreadyLoaded);
        }
        self.runtime_generation = self
            .runtime_generation
            .checked_add(1)
            .ok_or(BrokerError::CounterOverflow("runtime generation"))?;
        self.runtime_health = RuntimeHealth::Starting {
            generation: self.runtime_generation,
        };
        self.advance_revision();
        Ok(self.runtime_generation)
    }

    pub fn mark_runtime_ready(
        &mut self,
        generation: u64,
        binding: PiSessionBinding,
    ) -> Result<(), BrokerError> {
        self.require_current_generation(generation)?;
        if self.runtime_health != (RuntimeHealth::Starting { generation }) {
            return Err(BrokerError::InvalidRuntimeTransition);
        }
        self.pi_session = Some(binding);
        self.runtime_health = RuntimeHealth::Ready { generation };
        self.advance_revision();
        Ok(())
    }

    pub fn accept_runtime_event(&self, generation: u64) -> RuntimeEventDisposition {
        if generation == self.runtime_generation
            && matches!(
                self.runtime_health,
                RuntimeHealth::Starting { .. } | RuntimeHealth::Ready { .. }
            )
        {
            RuntimeEventDisposition::Current
        } else {
            RuntimeEventDisposition::Stale
        }
    }

    pub fn accept_prompt(
        &mut self,
        client_id: &ClientId,
        expected_revision: u64,
        operation_id: OperationId,
    ) -> Result<(), BrokerError> {
        self.require_revision(expected_revision)?;
        if !self.attachments.contains(client_id) {
            return Err(BrokerError::ClientNotAttached);
        }
        if !matches!(self.runtime_health, RuntimeHealth::Ready { .. }) {
            return Err(BrokerError::RuntimeNotReady);
        }
        if !self.foreground.is_idle() {
            return Err(BrokerError::ForegroundBusy);
        }
        self.foreground = ForegroundState::Running { operation_id };
        self.transfer_control(client_id)?;
        self.advance_revision();
        Ok(())
    }

    pub fn accept_cancel(
        &mut self,
        client_id: &ClientId,
        expected_revision: u64,
        operation_id: &OperationId,
    ) -> Result<(), BrokerError> {
        self.require_revision(expected_revision)?;
        if !self.attachments.contains(client_id) {
            return Err(BrokerError::ClientNotAttached);
        }
        let is_active = match &self.foreground {
            ForegroundState::Running {
                operation_id: active,
            }
            | ForegroundState::RequiresAction {
                operation_id: active,
                ..
            } => active == operation_id,
            ForegroundState::Idle { .. } => false,
        };
        if !is_active {
            return Err(BrokerError::OperationNotActive);
        }
        self.transfer_control(client_id)?;
        self.advance_revision();
        Ok(())
    }

    pub fn require_action(
        &mut self,
        generation: u64,
        operation_id: &OperationId,
        interaction_id: InteractionId,
    ) -> Result<(), BrokerError> {
        self.require_ready_generation(generation)?;
        match &self.foreground {
            ForegroundState::Running {
                operation_id: active,
            } if active == operation_id => {
                self.foreground = ForegroundState::RequiresAction {
                    operation_id: active.clone(),
                    interaction_id,
                };
                self.advance_revision();
                Ok(())
            }
            _ => Err(BrokerError::OperationNotActive),
        }
    }

    pub fn complete_foreground(
        &mut self,
        generation: u64,
        operation_id: &OperationId,
        stop_reason: StopReason,
    ) -> Result<(), BrokerError> {
        self.require_ready_generation(generation)?;
        let matches_operation = match &self.foreground {
            ForegroundState::Running {
                operation_id: active,
            }
            | ForegroundState::RequiresAction {
                operation_id: active,
                ..
            } => active == operation_id,
            ForegroundState::Idle { .. } => false,
        };
        if !matches_operation {
            return Err(BrokerError::OperationNotActive);
        }
        self.foreground = ForegroundState::Idle {
            last_stop_reason: Some(stop_reason),
        };
        self.advance_revision();
        Ok(())
    }

    pub fn runtime_exited(
        &mut self,
        generation: u64,
        _reason: impl Into<String>,
    ) -> Result<RuntimeEventDisposition, BrokerError> {
        if generation != self.runtime_generation {
            return Ok(RuntimeEventDisposition::Stale);
        }
        if matches!(self.runtime_health, RuntimeHealth::Unloaded) {
            return Err(BrokerError::InvalidRuntimeTransition);
        }
        if !self.foreground.is_idle() {
            self.foreground = ForegroundState::Idle {
                last_stop_reason: Some(StopReason::Interrupted),
            };
        }
        self.runtime_health = RuntimeHealth::Interrupted { generation };
        self.advance_revision();
        Ok(RuntimeEventDisposition::Current)
    }

    pub fn replace_pi_session(
        &mut self,
        generation: u64,
        binding: PiSessionBinding,
    ) -> Result<(), BrokerError> {
        self.require_ready_generation(generation)?;
        if !self.foreground.is_idle() {
            return Err(BrokerError::ForegroundBusy);
        }
        self.pi_session = Some(binding);
        self.advance_revision();
        Ok(())
    }

    fn require_revision(&self, expected: u64) -> Result<(), BrokerError> {
        if expected == self.revision {
            Ok(())
        } else {
            Err(BrokerError::RevisionConflict {
                expected,
                actual: self.revision,
            })
        }
    }

    fn require_current_generation(&self, generation: u64) -> Result<(), BrokerError> {
        if generation == self.runtime_generation {
            Ok(())
        } else {
            Err(BrokerError::StaleRuntimeGeneration {
                received: generation,
                current: self.runtime_generation,
            })
        }
    }

    fn require_ready_generation(&self, generation: u64) -> Result<(), BrokerError> {
        self.require_current_generation(generation)?;
        if self.runtime_health == (RuntimeHealth::Ready { generation }) {
            Ok(())
        } else {
            Err(BrokerError::RuntimeNotReady)
        }
    }

    fn transfer_control(&mut self, client_id: &ClientId) -> Result<(), BrokerError> {
        if self.active_client.as_ref() != Some(client_id) {
            self.active_client = Some(client_id.clone());
            self.control_epoch = self
                .control_epoch
                .checked_add(1)
                .ok_or(BrokerError::CounterOverflow("control epoch"))?;
        }
        Ok(())
    }

    fn advance_revision(&mut self) {
        self.revision = self.revision.checked_add(1).expect("revision overflow");
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BrokerError {
    #[error("invalid {kind} identifier: {value}")]
    InvalidIdentifier { kind: &'static str, value: String },
    #[error("{0} must not be empty")]
    EmptyValue(&'static str),
    #[error("runtime is already loaded")]
    RuntimeAlreadyLoaded,
    #[error("runtime is not ready")]
    RuntimeNotReady,
    #[error("invalid runtime state transition")]
    InvalidRuntimeTransition,
    #[error("persisted broker session violates recovery invariants")]
    InvalidRecoveryState,
    #[error("stale runtime generation {received}; current generation is {current}")]
    StaleRuntimeGeneration { received: u64, current: u64 },
    #[error("revision conflict: expected {expected}, current revision is {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("client is not attached")]
    ClientNotAttached,
    #[error("foreground operation is already active")]
    ForegroundBusy,
    #[error("target foreground operation is not active")]
    OperationNotActive,
    #[error("{0} counter overflow")]
    CounterOverflow(&'static str),
}

fn non_empty(label: &'static str, value: String) -> Result<String, BrokerError> {
    if value.trim().is_empty() {
        Err(BrokerError::EmptyValue(label))
    } else {
        Ok(value)
    }
}
