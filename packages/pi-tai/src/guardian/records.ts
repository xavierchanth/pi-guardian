import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WorkContextSnapshot } from "../work-context/domain.ts";
import { buildReviewPrompt, type ProposedAction, type ReviewDecision } from "./policy.ts";
import type { PathReviewEvidence } from "./paths.ts";
import type { WebFetchReviewEvidence } from "../web/domain.ts";
import type { ReviewResult } from "./reviewer.ts";

export interface GuardianReviewRecordInput {
  result: ReviewResult;
  action: ProposedAction;
  messages: readonly unknown[];
  workContext?: WorkContextSnapshot;
  reviewEvidence?: PathReviewEvidence | WebFetchReviewEvidence;
  mode: "tui" | "rpc" | "json" | "print";
  sessionId?: string;
  sessionFile?: string;
}

export interface GuardianReviewRecord {
  version: 1;
  id: string;
  timestamp: string;
  category: "denied" | "failed" | "timeout" | "cancelled";
  mode: GuardianReviewRecordInput["mode"];
  sessionId?: string;
  sessionFile?: string;
  action: ProposedAction;
  decision?: ReviewDecision;
  reason: string;
  reviewerInput: string;
}

export type GuardianReviewRecorder = (input: GuardianReviewRecordInput) => Promise<void>;

export function createGuardianReviewRecorder(
  root = join(getAgentDir(), "pi-tai", "guardian-reviews"),
): GuardianReviewRecorder {
  return async (input) => {
    const timestamp = new Date().toISOString();
    const id = `${timestamp.replaceAll(/[:.]/g, "-")}_${randomUUID()}`;
    const month = timestamp.slice(0, 7);
    const directory = join(root, month);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const record = toRecord(id, timestamp, input);
    const target = join(directory, `${id}.json`);
    const temporary = join(directory, `.${id}.${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
  };
}

function toRecord(
  id: string,
  timestamp: string,
  input: GuardianReviewRecordInput,
): GuardianReviewRecord {
  const decision = input.result.kind === "decision" ? input.result.decision : undefined;
  const category = input.result.kind === "decision"
    ? "denied"
    : input.result.kind === "failure"
      ? "failed"
      : input.result.kind;
  const reason = input.result.kind === "decision"
    ? input.result.decision.reason
    : input.result.reason;
  return {
    version: 1,
    id,
    timestamp,
    category,
    mode: input.mode,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
    action: input.action,
    ...(decision ? { decision } : {}),
    reason,
    reviewerInput: buildReviewPrompt(
      input.messages,
      input.action,
      input.workContext,
      input.reviewEvidence,
    ),
  };
}
