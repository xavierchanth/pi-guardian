import { createHash } from "node:crypto";
import type {
  CustodyCause,
  CustodyDisposition,
  CustodyRecord,
  WorkspaceCustodyPort,
} from "./custody-port.ts";

export type RepositoryGrade = "same" | "relocated" | "foreign" | "unknown";
export type HeadEvidence =
  | { kind: "unique"; changeId: string }
  | { kind: "divergent"; changeIds: readonly string[] }
  | { kind: "hidden"; changeIds?: readonly string[] }
  | { kind: "absent" }
  | { kind: "unknown" };
export interface CustodyEvidence {
  repository: RepositoryGrade;
  attachment: "present" | "absent" | "unknown";
  directory: "present" | "absent" | "unknown";
  heads: HeadEvidence;
  target?: "ancestor" | "not_ancestor" | "conflicted" | "unknown";
  mergeReceipt?: boolean;
  abandonReceipt?: boolean;
}
export interface CustodyDecision {
  disposition: CustodyDisposition;
  cause: CustodyCause;
  reason: string;
  heads: readonly string[];
  /** False means that unavailable evidence must not be written as authority. */
  mutate: boolean;
}

function result(
  disposition: CustodyDisposition,
  cause: CustodyCause,
  reason: string,
  heads: readonly string[],
  mutate = true,
): CustodyDecision {
  return { disposition, cause, reason, heads, mutate };
}

function transitionCause(
  from: CustodyDisposition,
  to: CustodyDisposition,
  ordinary: CustodyCause,
): CustodyCause {
  if (from === "incident" && to !== "incident") return "incident_resolved";
  if (from === to && ordinary !== "merge_conflicts_retained") return "heads_refreshed";
  return ordinary;
}

/** K5a's closed-world decision over repository, attachment, directory, heads, and target evidence. */
export function decideCustody(r: CustodyRecord, e: CustodyEvidence): CustodyDecision {
  const heads =
    e.heads.kind === "unique"
      ? [e.heads.changeId]
      : e.heads.kind === "divergent"
        ? [...new Set(e.heads.changeIds)].sort()
        : e.heads.kind === "hidden"
          ? [...new Set(e.heads.changeIds ?? r.headChangeIds)].sort()
          : e.heads.kind === "absent"
            ? []
            : r.headChangeIds;

  // Unavailable is not contradictory evidence. In particular, never persist unknown over known authority.
  if (
    e.repository === "unknown" ||
    e.attachment === "unknown" ||
    e.directory === "unknown" ||
    e.heads.kind === "unknown" ||
    e.target === "unknown"
  )
    return result(r.disposition, "heads_refreshed", "evidence unavailable", r.headChangeIds, false);

  if (e.repository === "foreign")
    return result(
      "incident",
      transitionCause(r.disposition, "incident", "ambiguity"),
      "foreign repository",
      heads,
    );

  // A visible head disproves abandonment even when the receipt itself is valid.
  if (e.abandonReceipt && e.heads.kind === "unique")
    return result(
      "incident",
      transitionCause(r.disposition, "incident", "ambiguity"),
      "abandon_contradicted",
      heads,
    );

  // Receipts stabilize abandonment only when usable evidence says its heads are hidden or absent.
  // This must remain ahead of the generic hidden/absent decisions below.
  if (e.abandonReceipt && (e.heads.kind === "hidden" || e.heads.kind === "absent"))
    return result(
      "abandoned",
      transitionCause(r.disposition, "abandoned", "abandon_receipted"),
      "verified abandon receipt",
      // Hidden/absent is evidence about visibility, not authority to erase the
      // heads named by the receipt. Preserve the recorded custody shape.
      r.headChangeIds,
    );

  if (e.heads.kind === "divergent" || e.heads.kind === "hidden")
    return result(
      "incident",
      transitionCause(r.disposition, "incident", "ambiguity"),
      "ambiguous heads",
      heads,
    );

  if (e.mergeReceipt && e.target === "ancestor")
    return result(
      "merged",
      transitionCause(r.disposition, "merged", "merge_proved"),
      "merge proved",
      heads,
    );

  // Conflict evidence cannot manufacture an attachment which attachment evidence denies.
  if (e.target === "conflicted" && e.attachment === "present")
    return result(
      "attached",
      transitionCause(r.disposition, "attached", "merge_conflicts_retained"),
      "conflicts retained",
      heads,
    );

  // Relocation must precede the ordinary attached row or repo_rebound is unreachable.
  if (e.repository === "relocated" && e.attachment === "present" && e.directory === "present")
    return result("attached", "repo_rebound", "repository relocated", heads);

  if (e.attachment === "present" && e.directory === "present")
    return result(
      "attached",
      transitionCause(r.disposition, "attached", "attach_proved"),
      "attachment proved",
      heads,
    );
  if (e.attachment === "absent" && heads.length)
    return result(
      "detached",
      transitionCause(r.disposition, "detached", "evidence_missing"),
      "heads survive detached",
      heads,
    );
  if (e.directory === "absent" && heads.length)
    return result(
      "detached",
      transitionCause(r.disposition, "detached", "evidence_missing"),
      "directory absent; heads survive",
      heads,
    );
  if (e.attachment === "absent" && e.directory === "present")
    return result(
      "detached",
      transitionCause(r.disposition, "detached", "forget"),
      "attachment absent",
      heads,
    );
  if (e.attachment === "absent" && e.directory === "absent" && heads.length === 0)
    return result(
      "missing",
      transitionCause(r.disposition, "missing", "evidence_missing"),
      "all evidence absent",
      heads,
    );

  return result(
    "incident",
    transitionCause(r.disposition, "incident", "ambiguity"),
    "contradictory evidence",
    heads,
  );
}

export class CustodyReconciler {
  private readonly port: WorkspaceCustodyPort;
  private readonly identity: { rootSessionId: string; pid: number; processIdentity: string };

  constructor(
    port: WorkspaceCustodyPort,
    identity: { rootSessionId: string; pid: number; processIdentity: string },
  ) {
    this.port = port;
    this.identity = identity;
  }

  async reconcile(
    record: CustodyRecord,
    evidence: CustodyEvidence,
    now = new Date().toISOString(),
  ): Promise<CustodyRecord> {
    const d = decideCustody(record, evidence);
    if (!d.mutate) return record;
    const canonical = [...new Set(d.heads)].sort();
    if (
      record.disposition === d.disposition &&
      JSON.stringify(record.headChangeIds) === JSON.stringify(canonical) &&
      record.attachmentEvidence === evidence.attachment &&
      record.directoryEvidence === evidence.directory
    )
      return record;

    const digest = createHash("sha256")
      .update(JSON.stringify([record.id, d, evidence.repository, canonical]))
      .digest("hex");
    const opId = `reconcile:${digest}`;
    await this.port.begin({
      opId,
      workspaceId: record.id,
      repoId: record.repoId,
      kind: "reconcile",
      requestedBy: "system_reconcile",
      pid: this.identity.pid,
      processIdentity: this.identity.processIdentity,
      now,
    });
    return this.port.commit(opId, {
      workspaceId: record.id,
      ownRootSessionId: this.identity.rootSessionId,
      disposition: d.disposition,
      cause: d.cause,
      now,
      patch: {
        headChangeIds: canonical,
        attachmentEvidence: evidence.attachment,
        directoryEvidence: evidence.directory,
        evidenceAt: now,
        attention: record.attention || d.disposition === "incident",
        ...(d.disposition === "incident"
          ? { incident: { stage: "reconcile", reason: d.reason } }
          : { incident: undefined }),
      },
    });
  }
}
