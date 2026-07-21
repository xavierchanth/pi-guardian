export const GUARDIAN_REVIEW_FAILED_EVENT = "pi-tai:guardian-review-failed";

export interface GuardianReviewFailedEvent {
  kind: "failure" | "timeout";
  mode: "tui" | "rpc" | "json" | "print";
}
