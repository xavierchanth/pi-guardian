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
}
const incident = (reason: string, heads: readonly string[] = []): CustodyDecision => ({
  disposition: "incident",
  cause: "ambiguity",
  reason,
  heads,
});

/** K5's closed-world decision table. The ordered branches are the seventeen exhaustive rows. */
export function decideCustody(r: CustodyRecord, e: CustodyEvidence): CustodyDecision {
  const heads =
    e.heads.kind === "unique"
      ? [e.heads.changeId]
      : e.heads.kind === "divergent"
        ? [...new Set(e.heads.changeIds)].sort()
        : e.heads.kind === "hidden"
          ? [...new Set(e.heads.changeIds ?? r.headChangeIds)].sort()
          : [];
  if (e.repository === "unknown") return incident("repository evidence unavailable", heads); // 1
  if (e.repository === "foreign")
    return incident("workspace belongs to a foreign repository", heads); // 2
  if (e.attachment === "unknown" || e.directory === "unknown" || e.heads.kind === "unknown")
    return incident("custody evidence unavailable", heads); // 3
  if (e.heads.kind === "divergent") return incident("divergent workspace heads", heads); // 4
  if (e.heads.kind === "hidden") return incident("workspace head is hidden", heads); // 5
  if (r.disposition === "abandoned" && !e.abandonReceipt)
    return incident("abandoned state lacks an exact receipt", heads); // 6
  if (r.disposition === "merged" && (!e.mergeReceipt || e.target === "unknown"))
    return incident("merged state lacks exact proof", heads); // 7
  if (e.target === "conflicted")
    return {
      disposition: "attached",
      cause: "merge_conflicts_retained",
      reason: "conflicts retained",
      heads,
    }; // 8
  if (e.abandonReceipt && e.attachment === "absent" && !heads.length)
    return {
      disposition: "abandoned",
      cause: "abandon_receipted",
      reason: "verified abandon receipt",
      heads,
    }; // 9
  if (e.mergeReceipt && e.target === "ancestor")
    return {
      disposition: "merged",
      cause: "merge_proved",
      reason: "target ancestry proved",
      heads,
    }; // 10
  if (e.attachment === "present" && e.directory === "present")
    return {
      disposition: "attached",
      cause: "attach_proved",
      reason: "workspace attachment proved",
      heads,
    }; // 11
  if (e.attachment === "absent" && heads.length)
    return {
      disposition: "detached",
      cause: "evidence_missing",
      reason: "heads survive without attachment",
      heads,
    }; // 12
  if (e.directory === "absent" && heads.length)
    return {
      disposition: "detached",
      cause: "evidence_missing",
      reason: "directory deleted but heads survive",
      heads,
    }; // 13
  if (e.attachment === "absent" && e.directory === "present")
    return { disposition: "detached", cause: "forget", reason: "directory is detached", heads }; // 14
  if (e.attachment === "absent" && e.directory === "absent" && !heads.length)
    return {
      disposition: "missing",
      cause: "evidence_missing",
      reason: "workspace and heads are absent",
      heads,
    }; // 15
  if (e.repository === "relocated" && e.attachment === "present")
    return {
      disposition: "attached",
      cause: "repo_rebound",
      reason: "repository relocated",
      heads,
    }; // 16
  return incident("unclassified or contradictory evidence", heads); // 17
}

export class CustodyReconciler {
  constructor(
    private readonly port: WorkspaceCustodyPort,
    private readonly identity: { rootSessionId: string; pid: number; processIdentity: string },
  ) {}
  async reconcile(
    record: CustodyRecord,
    evidence: CustodyEvidence,
    now = new Date().toISOString(),
  ): Promise<CustodyRecord> {
    const d = decideCustody(record, evidence);
    const canonical = [...new Set(d.heads)].sort();
    if (
      record.disposition === d.disposition &&
      JSON.stringify(record.headChangeIds) === JSON.stringify(canonical) &&
      record.attachmentEvidence === evidence.attachment &&
      record.directoryEvidence === evidence.directory
    )
      return record;
    const opId = `reconcile:${record.id}:${Buffer.from(JSON.stringify([d, evidence.repository, canonical])).toString("base64url")}`;
    try {
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
    } catch {
      const current = await this.port.get(record.id);
      if (current) return current;
      throw new Error("custody reconciliation intent collision");
    }
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
        attention: d.disposition === "incident",
        ...(d.disposition === "incident"
          ? { incident: { stage: "reconcile", reason: d.reason } }
          : { incident: undefined }),
      },
    });
  }
}
