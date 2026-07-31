import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCmuxIntegrationActive } from "../cmux/register.ts";
import type { ClientPreferencesReader } from "../../core/config/register.ts";
import { GUARDIAN_REVIEW_FAILED_EVENT, type GuardianReviewFailedEvent } from "./events.ts";
import { sendNativeTerminalNotification, type NotificationSender } from "./native.ts";

const MAX_IDENTITY_LENGTH = 80;
const MAX_RESPONSE_LENGTH = 240;

export function registerNotifications(
  pi: ExtensionAPI,
  configService: ClientPreferencesReader,
  send: NotificationSender = sendNativeTerminalNotification,
  environment: NodeJS.ProcessEnv = process.env,
  cmuxActive: typeof isCmuxIntegrationActive = isCmuxIntegrationActive,
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
    if (event.mode !== "tui" || !configService.clientPreferences().notifications.reviewFailure)
      return;
    const fallback =
      event.kind === "timeout"
        ? "Automatic action review timed out."
        : "Automatic action review failed.";
    const detail = event.reason?.trim() || fallback;
    const body = event.toolName?.trim() ? `${event.toolName.trim()} — ${detail}` : detail;
    notify(notificationTitle(pi, event.cwd), body);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || !configService.clientPreferences().notifications.agentCompletion)
      return;
    if (cmuxActive(configService, environment)) return;
    notify(notificationTitle(pi, ctx.cwd), completionBody(ctx));
  });
}

function notificationTitle(pi: ExtensionAPI, cwd?: string): string {
  let identity: string | undefined;
  try {
    identity = pi.getSessionName()?.trim();
  } catch {
    // Session naming is optional; cwd remains a deterministic fallback.
  }
  if (!identity && cwd) identity = basename(cwd).trim() || undefined;
  return identity ? `Pi-Tai · ${truncate(identity, MAX_IDENTITY_LENGTH)}` : "Pi-Tai";
}

function completionBody(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager.buildContextEntries();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index] as unknown;
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
      if (entry.message.role !== "assistant") continue;
      const text = assistantText(entry.message.content);
      if (text) return truncate(text, MAX_RESPONSE_LENGTH);
    }
  } catch {
    // Transcript projection is best-effort and cannot interrupt settlement.
  }
  return "Ready for input.";
}

function assistantText(content: unknown): string | undefined {
  const parts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string"
              ? [block.text]
              : [],
          )
        : [];
  const normalized = parts.join(" ").replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
