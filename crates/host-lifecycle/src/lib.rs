#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthState {
    Starting,
    Ready,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowCloseAction {
    HideWindowKeepHostRunning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitRequest {
    QuitNow,
    WarnActiveTurns { count: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostLifecycle {
    health: HealthState,
    active_turns: usize,
    quit_warning_pending: bool,
}

impl Default for HostLifecycle {
    fn default() -> Self {
        Self {
            health: HealthState::Starting,
            active_turns: 0,
            quit_warning_pending: false,
        }
    }
}

impl HostLifecycle {
    pub fn health(&self) -> HealthState {
        self.health
    }

    pub fn mark_ready(&mut self) {
        self.health = HealthState::Ready;
    }

    pub fn mark_degraded(&mut self) {
        self.health = HealthState::Degraded;
    }

    pub fn active_turns(&self) -> usize {
        self.active_turns
    }

    pub fn set_active_turns(&mut self, count: usize) {
        self.active_turns = count;
        if count == 0 {
            self.quit_warning_pending = false;
        }
    }

    pub fn window_close_requested(&self) -> WindowCloseAction {
        WindowCloseAction::HideWindowKeepHostRunning
    }

    pub fn request_quit(&mut self) -> QuitRequest {
        if self.active_turns == 0 {
            return QuitRequest::QuitNow;
        }
        self.quit_warning_pending = true;
        QuitRequest::WarnActiveTurns {
            count: self.active_turns,
        }
    }

    pub fn confirm_quit(&mut self) -> bool {
        std::mem::take(&mut self.quit_warning_pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_transitions_are_shell_independent() {
        let mut lifecycle = HostLifecycle::default();
        assert_eq!(lifecycle.health(), HealthState::Starting);
        lifecycle.mark_ready();
        assert_eq!(lifecycle.health(), HealthState::Ready);
        lifecycle.mark_degraded();
        assert_eq!(lifecycle.health(), HealthState::Degraded);
    }

    #[test]
    fn closing_a_window_never_requests_host_shutdown() {
        let lifecycle = HostLifecycle::default();
        assert_eq!(
            lifecycle.window_close_requested(),
            WindowCloseAction::HideWindowKeepHostRunning
        );
    }

    #[test]
    fn idle_host_quits_without_confirmation() {
        let mut lifecycle = HostLifecycle::default();
        assert_eq!(lifecycle.request_quit(), QuitRequest::QuitNow);
        assert!(!lifecycle.confirm_quit());
    }

    #[test]
    fn active_turns_require_an_explicit_second_decision() {
        let mut lifecycle = HostLifecycle::default();
        lifecycle.set_active_turns(2);

        assert_eq!(
            lifecycle.request_quit(),
            QuitRequest::WarnActiveTurns { count: 2 }
        );
        assert!(lifecycle.confirm_quit());
        assert!(!lifecycle.confirm_quit());
    }

    #[test]
    fn completing_active_turns_clears_a_pending_warning() {
        let mut lifecycle = HostLifecycle::default();
        lifecycle.set_active_turns(1);
        lifecycle.request_quit();
        lifecycle.set_active_turns(0);
        assert!(!lifecycle.confirm_quit());
    }
}
