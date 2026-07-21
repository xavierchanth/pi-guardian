export const GUARDIAN_REVIEW_FAILED_EVENT = "pi-tai:guardian-review-failed";

export interface GuardianReviewFailedEvent {
  kind: "failure" | "timeout";
  mode: "tui" | "rpc" | "json" | "print";
}

export const GUARDIAN_CONFIRMATION_REQUIRED_EVENT = "pi-tai:guardian-confirmation-required";

export interface GuardianConfirmationRequiredEvent {
  mode: "tui" | "rpc" | "json" | "print";
  riskLevel: "low" | "medium" | "high" | "critical";
}
