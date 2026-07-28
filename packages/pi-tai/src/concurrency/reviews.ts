import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TaskSnapshotReceipt } from "./tasks.ts";
import { HostConcurrencyState } from "./host-state.ts";

export type ReviewSeverity = "p0" | "p1" | "p2" | "p3" | "p4";
export type ReviewRelation = "introduced" | "in_scope_existing" | "out_of_scope_existing";
export interface ReviewFindingV1 { readonly findingId: string; readonly severity: ReviewSeverity; readonly relation: ReviewRelation; readonly summary: string; readonly evidence: string; readonly criterion?: string; readonly changeIds: readonly string[]; readonly paths: readonly string[]; readonly suggestedCorrection?: string; readonly focusedReviewable: boolean; }
export interface ReviewBundleV1 { readonly bundleId: string; readonly workspaceId: string; readonly reportVersion: number; readonly taskSnapshot: TaskSnapshotReceipt; readonly rootChangeId: string; readonly workspaceHeadChangeId: string; readonly contentTipChangeId: string; readonly orderedChangeIds: readonly string[]; readonly normalizedPatchHash: string; readonly conflictPaths: readonly string[]; readonly evidenceDigest: string; readonly createdAt: string; }
export interface ReviewerReportV1 { readonly reviewId: string; readonly bundleId: string; readonly reviewerContextId: string; readonly cycle: number; readonly summary: string; readonly findings: readonly ReviewFindingV1[]; readonly validation: readonly string[]; readonly submittedAt: string; }
export type FindingDispositionV1 = { readonly findingId: string; readonly disposition: "deferred" | "not_applicable"; readonly rationale: string };
export interface ReviewApprovalReceiptV1 { readonly approvalId: string; readonly reviewId: string; readonly bundleId: string; readonly workspaceId: string; readonly taskSnapshotDigest: string; readonly rootChangeId: string; readonly workspaceHeadChangeId: string; readonly contentTipChangeId: string; readonly orderedChangeIds: readonly string[]; readonly normalizedPatchHash: string; readonly evidenceDigest: string; readonly dispositions: readonly FindingDispositionV1[]; readonly approvedByContextId: string; readonly approvedAt: string; readonly receiptDigest: string; }
export type PersistedReviewV1 =
  | { readonly version: 1; readonly phase: "prepared"; readonly bundle: ReviewBundleV1 }
  | { readonly version: 1; readonly phase: "reported"; readonly bundle: ReviewBundleV1; readonly report: ReviewerReportV1 }
  | { readonly version: 1; readonly phase: "approved"; readonly bundle: ReviewBundleV1; readonly report: ReviewerReportV1; readonly approval: ReviewApprovalReceiptV1 };

export interface ReviewStore { create(record: PersistedReviewV1): Promise<void>; get(reviewId: string): Promise<PersistedReviewV1 | undefined>; replace(reviewId: string, priorPhase: PersistedReviewV1["phase"], next: PersistedReviewV1): Promise<void>; list(): Promise<PersistedReviewV1[]>; }
export class FileReviewStore implements ReviewStore {
  readonly root: string; constructor(root: string) { this.root = resolve(root); }
  async create(record: PersistedReviewV1): Promise<void> { const value = validateReview(record); await mkdir(this.root, { recursive: true, mode: 0o700 }); await writeFile(this.path(reviewIdOf(value)), serialize(value), { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  async get(reviewId: string): Promise<PersistedReviewV1 | undefined> { try { return validateReview(JSON.parse(await readFile(this.path(reviewId), "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  async replace(reviewId: string, priorPhase: PersistedReviewV1["phase"], next: PersistedReviewV1): Promise<void> { const current = await this.get(reviewId); if (!current || current.phase !== priorPhase) throw new Error(`Review ${reviewId} is not in ${priorPhase}.`); const value = validateReview(next); if (reviewIdOf(value) !== reviewId || JSON.stringify(current.bundle) !== JSON.stringify(value.bundle)) throw new Error("Review transition cannot change identity or bundle."); await writeFile(this.path(reviewId), serialize(value), { encoding: "utf8", mode: 0o600, flag: "w" }); }
  async list(): Promise<PersistedReviewV1[]> { try { const output: PersistedReviewV1[] = []; for (const name of (await readdir(this.root)).filter((item) => item.endsWith(".json")).sort()) { const value = await this.get(name.slice(0, -5)); if (value) output.push(value); } return output; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  private path(reviewId: string) { id(reviewId, "review"); return join(this.root, `${reviewId}.json`); }
}

export class HostReviewStore implements ReviewStore {
  private readonly state: HostConcurrencyState;
  constructor(state: HostConcurrencyState) { this.state = state; }
  async create(record: PersistedReviewV1): Promise<void> {
    const value = validateReview(record); const reviewId = reviewIdOf(value);
    await this.state.mutateSegment<PersistedReviewV1>("reviews", "review.prepared", { reviewId }, (reviews) => {
      if (reviews.some((review) => reviewIdOf(review) === reviewId)) throw new Error(`Review already exists: ${reviewId}`);
      return [...reviews, value];
    });
  }
  async get(reviewId: string): Promise<PersistedReviewV1 | undefined> { return (await this.list()).find((review) => reviewIdOf(review) === reviewId); }
  async replace(reviewId: string, priorPhase: PersistedReviewV1["phase"], next: PersistedReviewV1): Promise<void> {
    const value = validateReview(next); let replaced = false;
    await this.state.mutateSegment<PersistedReviewV1>("reviews", `review.${value.phase}`, { reviewId }, (reviews) => reviews.map((review) => {
      if (reviewIdOf(review) !== reviewId) return review;
      if (review.phase !== priorPhase || reviewIdOf(value) !== reviewId || JSON.stringify(review.bundle) !== JSON.stringify(value.bundle)) throw new Error(`Review ${reviewId} cannot transition from ${review.phase}.`);
      replaced = true; return value;
    }));
    if (!replaced) throw new Error(`Unknown review: ${reviewId}`);
  }
  async list(): Promise<PersistedReviewV1[]> { return (await this.state.readSegment<PersistedReviewV1>("reviews")).map(validateReview); }
}

export class ReviewService {
  private readonly store: ReviewStore; private readonly now: () => string;
  constructor(store: ReviewStore, now = () => new Date().toISOString()) { this.store = store; this.now = now; }
  async prepare(input: Omit<ReviewBundleV1, "bundleId" | "createdAt">): Promise<ReviewBundleV1> { const bundle: ReviewBundleV1 = { ...input, bundleId: `review-${randomUUID()}`, createdAt: this.now() }; await this.store.create({ version: 1, phase: "prepared", bundle }); return bundle; }
  async submit(bundleId: string, input: Omit<ReviewerReportV1, "reviewId" | "bundleId" | "submittedAt">): Promise<ReviewerReportV1> { const current = await this.require(bundleId); if (current.phase !== "prepared") throw new Error("Review report was already submitted."); const report = validateReport({ ...input, reviewId: bundleId, bundleId, submittedAt: this.now() }); await this.store.replace(bundleId, "prepared", { version: 1, phase: "reported", bundle: current.bundle, report }); return report; }
  async approve(reviewId: string, input: { approvedByContextId: string; dispositions: readonly FindingDispositionV1[] }): Promise<ReviewApprovalReceiptV1> { const current = await this.require(reviewId); if (current.phase !== "reported") throw new Error("Review is not awaiting an approval decision."); if (current.report.findings.some((finding) => finding.severity === "p0" || finding.severity === "p1")) throw new Error("p0 and p1 findings must be fixed and removed by focused re-review before approval."); const byId = new Map(input.dispositions.map((item) => [item.findingId, item])); for (const finding of current.report.findings) { if (finding.severity === "p2" && !byId.has(finding.findingId)) throw new Error(`p2 finding ${finding.findingId} requires a disposition.`); } for (const disposition of input.dispositions) { const finding = current.report.findings.find((item) => item.findingId === disposition.findingId); if (!finding) throw new Error(`Unknown finding disposition: ${disposition.findingId}`); if (!disposition.rationale.trim()) throw new Error("Finding disposition rationale is required."); }
    const base = { approvalId: `approval-${randomUUID()}`, reviewId, bundleId: current.bundle.bundleId, workspaceId: current.bundle.workspaceId, taskSnapshotDigest: current.bundle.taskSnapshot.digest, rootChangeId: current.bundle.rootChangeId, workspaceHeadChangeId: current.bundle.workspaceHeadChangeId, contentTipChangeId: current.bundle.contentTipChangeId, orderedChangeIds: current.bundle.orderedChangeIds, normalizedPatchHash: current.bundle.normalizedPatchHash, evidenceDigest: current.bundle.evidenceDigest, dispositions: input.dispositions, approvedByContextId: input.approvedByContextId, approvedAt: this.now() }; const approval: ReviewApprovalReceiptV1 = { ...base, receiptDigest: hash(base) }; await this.store.replace(reviewId, "reported", { version: 1, phase: "approved", bundle: current.bundle, report: current.report, approval }); return approval; }
  async status(reviewId: string): Promise<PersistedReviewV1> { return this.require(reviewId); }
  async requireApproval(reviewId: string): Promise<ReviewApprovalReceiptV1> { const record = await this.require(reviewId); if (record.phase !== "approved" || record.approval.receiptDigest !== hash({ ...record.approval, receiptDigest: undefined }, true)) throw new Error("Review approval receipt is invalid."); return record.approval; }
  async requireBundle(reviewId: string): Promise<ReviewBundleV1> { return (await this.require(reviewId)).bundle; }
  private async require(reviewId: string) { const value = await this.store.get(reviewId); if (!value) throw new Error(`Unknown review: ${reviewId}`); return value; }
}

export function validateReview(input: unknown): PersistedReviewV1 { if (!object(input) || input.version !== 1 || !["prepared", "reported", "approved"].includes(String(input.phase))) throw new Error("Review record is invalid."); validateBundle(input.bundle); if (input.phase === "reported" || input.phase === "approved") validateReport(input.report); if (input.phase === "approved") { if (!object(input.approval)) throw new Error("Approved review requires receipt."); id(nonempty(input.approval.approvalId, "approval ID"), "approval"); digest(nonempty(input.approval.receiptDigest, "approval digest")); } return input as unknown as PersistedReviewV1; }
function validateBundle(value: unknown): void { if (!object(value)) throw new Error("Review bundle is invalid."); id(nonempty(value.bundleId, "bundle ID"), "review"); id(nonempty(value.workspaceId, "workspace ID"), "workspace"); if (!Number.isSafeInteger(value.reportVersion) || (value.reportVersion as number) < 1) throw new Error("Review report version is invalid."); if (!object(value.taskSnapshot)) throw new Error("Review task snapshot is required."); for (const key of ["rootChangeId", "workspaceHeadChangeId", "contentTipChangeId"] as const) change(nonempty(value[key], key)); if (!Array.isArray(value.orderedChangeIds) || value.orderedChangeIds.length === 0 || value.orderedChangeIds[0] !== value.rootChangeId || value.orderedChangeIds.at(-1) !== value.contentTipChangeId) throw new Error("Review range is not exact and inclusive."); for (const item of value.orderedChangeIds) change(nonempty(item, "ordered change")); digest(nonempty(value.normalizedPatchHash, "patch hash")); digest(nonempty(value.evidenceDigest, "evidence digest")); if (!Array.isArray(value.conflictPaths)) throw new Error("Review conflict paths are required."); }
function validateReport(value: unknown): ReviewerReportV1 { if (!object(value)) throw new Error("Reviewer report is invalid."); id(nonempty(value.reviewId, "review ID"), "review"); id(nonempty(value.bundleId, "bundle ID"), "review"); id(nonempty(value.reviewerContextId, "reviewer context"), "context"); if (!Number.isSafeInteger(value.cycle) || (value.cycle as number) < 0) throw new Error("Review cycle is invalid."); text(value.summary, "review summary", 16_000); if (!Array.isArray(value.findings) || !Array.isArray(value.validation)) throw new Error("Review findings and validation are required."); const ids = new Set<string>(); for (const finding of value.findings) { if (!object(finding)) throw new Error("Review finding is invalid."); id(nonempty(finding.findingId, "finding ID"), "finding"); if (ids.has(finding.findingId)) throw new Error("Duplicate review finding."); ids.add(finding.findingId); if (!["p0", "p1", "p2", "p3", "p4"].includes(String(finding.severity)) || !["introduced", "in_scope_existing", "out_of_scope_existing"].includes(String(finding.relation))) throw new Error("Review finding classification is invalid."); text(finding.summary, "finding summary", 8_000); text(finding.evidence, "finding evidence", 16_000); if (!Array.isArray(finding.changeIds) || !Array.isArray(finding.paths) || typeof finding.focusedReviewable !== "boolean") throw new Error("Review finding evidence scope is invalid."); } nonempty(value.submittedAt, "review submittedAt"); return value as unknown as ReviewerReportV1; }
function reviewIdOf(record: PersistedReviewV1): string { return record.bundle.bundleId; }
function hash(value: unknown, stripUndefined = false): string { const normalized = stripUndefined ? JSON.parse(JSON.stringify(value)) : value; return createHash("sha256").update(JSON.stringify(normalized)).digest("hex"); }
function id(value: string, label: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error(`Invalid ${label}: ${value}`); }
function change(value: string): void { if (!/^[a-z]{32}$/.test(value)) throw new Error(`Invalid Change ID: ${value}`); }
function digest(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid digest: ${value}`); }
function text(value: unknown, label: string, max: number): string { const result = nonempty(value, label).trim(); if (Buffer.byteLength(result, "utf8") > max) throw new Error(`${label} exceeds ${max} bytes.`); return result; }
function nonempty(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty.`); return value; }
function object(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
