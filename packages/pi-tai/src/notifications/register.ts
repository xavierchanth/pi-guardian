import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiTaiConfigService } from "../config/register.ts";
import {
  GUARDIAN_REVIEW_FAILED_EVENT,
  type GuardianReviewFailedEvent,
} from "./events.ts";
import {
  sendNativeTerminalNotification,
  type NotificationSender,
} from "./native.ts";

export function registerNotifications(
  pi: ExtensionAPI,
  configService: PiTaiConfigService,
  send: NotificationSender = sendNativeTerminalNotification,
): void {
  const notify = (title: string, body: string) => {
    try {
      send(title, body);
    } catch {
      // Notification support must never interrupt agent work.
    }
  };

  pi.events.on(GUARDIAN_REVIEW_FAILED_EVENT, (data) => {
    const event = data as GuardianReviewFailedEvent;
    if (event.mode !== "tui" || !configService.current().notifications.reviewFailure) return;
    const body = event.kind === "timeout"
      ? "Automatic action review timed out."
      : "Automatic action review failed.";
    notify("Pi-Tai review", body);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || !configService.current().notifications.agentCompletion) return;
    notify("Pi-Tai", "Ready for input.");
  });
}
