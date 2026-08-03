import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory, privateChild, type StoragePaths } from "../storage/paths.ts";
import { TASK_STATES, type TaskId, type TaskState } from "./authority.ts";

const HUMAN = Symbol("host human authority");
type HumanCapability = { readonly [HUMAN]: true; readonly principal: string };
export function issueHumanCapability(principal: string): HumanCapability {
  if (!principal.trim()) throw new Error("invalid principal");
  return Object.freeze({ [HUMAN]: true as const, principal });
}
export interface Receipt {
  operationId: string;
  taskId: TaskId;
  kind: "created" | "revised" | "transitioned" | "recovered";
  beforeRevision: number | null;
  afterRevision: number;
  beforeState: TaskState | null;
  afterState: TaskState;
  beforeDigest: string | null;
  afterDigest: string;
}
export interface HumanTask {
  taskId: TaskId;
  displayId: string;
  state: TaskState;
  title: string;
  revision: number;
  digest: string;
  provenanceSessionId?: string;
}
export class TaskAuthorityError extends Error {
  readonly code: "invalid" | "conflict";
  constructor(code: "invalid" | "conflict", message = "Task mutation could not be completed") {
    super(message);
    this.code = code;
  }
}

/** Host composition port. This module is intentionally absent from the public core facade. */
export class HumanTaskAuthority {
  private db: DatabaseSync;
  private paths: StoragePaths;
  private repoId: string;
  private cap: HumanCapability;
  private constructor(db: DatabaseSync, paths: StoragePaths, repoId: string, cap: HumanCapability) {
    this.db = db;
    this.paths = paths;
    this.repoId = repoId;
    this.cap = cap;
  }
  static inject(
    db: DatabaseSync,
    paths: StoragePaths,
    repoId: string,
    cap: HumanCapability,
  ): HumanTaskAuthority {
    if (
      cap?.[HUMAN] !== true ||
      !db.prepare("SELECT 1 FROM repository WHERE repo_id=? AND identity_proven=1").get(repoId)
    )
      throw new TaskAuthorityError("invalid");
    return new HumanTaskAuthority(db, paths, repoId, cap);
  }
  create(
    operationId: string,
    title: string,
    body: string,
    provenanceSessionId?: string,
  ): { task: HumanTask; receipt: Receipt } {
    operation(operationId);
    title = normalizeTitle(title);
    validateBody(body);
    this.provenance(provenanceSessionId);
    const prior = this.retry(operationId);
    if (prior) return prior;
    const id = `task_${randomUUID().replaceAll("-", "")}` as TaskId,
      digest = sha(body),
      now = new Date().toISOString();
    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO task_display_sequence(repo_id,next_value) VALUES(?,2) ON CONFLICT(repo_id) DO UPDATE SET next_value=next_value+1",
        )
        .run(this.repoId);
      const seq = (
        this.db
          .prepare("SELECT next_value-1 n FROM task_display_sequence WHERE repo_id=?")
          .get(this.repoId) as { n: number }
      ).n;
      this.intent(operationId, id, "created", 1, digest, body);
      this.db
        .prepare("UPDATE task_operation SET payload=? WHERE operation_id=?")
        .run(JSON.stringify({ title, seq, provenanceSessionId }), operationId);
    });
    this.publish(id, 1, body, digest);
    return this.tx(() => {
      const op = this.op(operationId);
      const p = JSON.parse(op.payload) as {
        title: string;
        seq: number;
        provenanceSessionId?: string;
      };
      this.db
        .prepare(
          "INSERT INTO task(task_id,repo_id,display_seq,display_id,title,state,current_revision,current_digest,provenance_session_id,created_at,updated_at) VALUES(?,?,?,?,?,'open',1,?,?,?,?)",
        )
        .run(
          id,
          this.repoId,
          p.seq,
          `T-${p.seq}`,
          p.title,
          digest,
          p.provenanceSessionId ?? null,
          now,
          now,
        );
      this.db
        .prepare("INSERT INTO task_revision VALUES(?,?,?,?,?,?)")
        .run(id, 1, digest, Buffer.byteLength(body), this.rel(id, 1), now);
      return this.finish(operationId, "created", null, 1, null, "open", null, digest);
    });
  }
  revise(operationId: string, id: TaskId, expectedRevision: number, body: string) {
    operation(operationId);
    validateBody(body);
    const prior = this.retry(operationId);
    if (prior) return prior;
    const row = this.owned(id);
    if (row.current_revision !== expectedRevision) throw new TaskAuthorityError("conflict");
    const rev = expectedRevision + 1,
      digest = sha(body);
    this.tx(() => this.intent(operationId, id, "revised", rev, digest, body));
    this.publish(id, rev, body, digest);
    return this.tx(() => {
      const current = this.owned(id);
      if (current.current_revision !== expectedRevision) throw new TaskAuthorityError("conflict");
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO task_revision VALUES(?,?,?,?,?,?)")
        .run(id, rev, digest, Buffer.byteLength(body), this.rel(id, rev), now);
      this.db
        .prepare(
          "UPDATE task SET current_revision=?,current_digest=?,updated_at=? WHERE task_id=? AND repo_id=? AND current_revision=?",
        )
        .run(rev, digest, now, id, this.repoId, expectedRevision);
      return this.finish(
        operationId,
        "revised",
        expectedRevision,
        rev,
        current.state,
        current.state,
        current.current_digest,
        digest,
      );
    });
  }
  transition(
    operationId: string,
    id: TaskId,
    expectedState: TaskState,
    expectedRevision: number,
    to: TaskState,
  ) {
    operation(operationId);
    if (!TASK_STATES.includes(to)) throw new TaskAuthorityError("invalid");
    const prior = this.retry(operationId);
    if (prior) return prior;
    return this.tx(() => {
      const r = this.owned(id);
      if (r.state !== expectedState || r.current_revision !== expectedRevision)
        throw new TaskAuthorityError("conflict");
      this.intent(operationId, id, "transitioned", r.current_revision, r.current_digest, "");
      this.db
        .prepare(
          "INSERT INTO task_audit(audit_id,task_id,repo_id,actor,principal,operation,from_state,to_state,created_at) VALUES(?,?,?,'human',?,'transition',?,?,?)",
        )
        .run(
          `audit_${randomUUID()}`,
          id,
          this.repoId,
          this.cap.principal,
          r.state,
          to,
          new Date().toISOString(),
        );
      const result = this.db
        .prepare(
          "UPDATE task SET state=?,updated_at=? WHERE task_id=? AND repo_id=? AND state=? AND current_revision=?",
        )
        .run(to, new Date().toISOString(), id, this.repoId, expectedState, expectedRevision);
      if (result.changes !== 1) throw new TaskAuthorityError("conflict");
      return this.finish(
        operationId,
        "transitioned",
        r.current_revision,
        r.current_revision,
        r.state,
        to,
        r.current_digest,
        r.current_digest,
      );
    });
  }
  reconcile(): Array<{ task: HumanTask; receipt: Receipt }> {
    const rows = this.db
      .prepare(
        "SELECT operation_id FROM task_operation WHERE repo_id=? AND principal=? AND status='intent' ORDER BY created_at",
      )
      .all(this.repoId, this.cap.principal) as { operation_id: string }[];
    const out: Array<{ task: HumanTask; receipt: Receipt }> = [];
    for (const { operation_id } of rows) {
      const o = this.op(operation_id);
      if (o.kind === "created") {
        const p = JSON.parse(o.payload) as {
          title: string;
          seq: number;
          provenanceSessionId?: string;
        };
        const body = this.staged(o.task_id as TaskId, o.target_revision, o.target_digest);
        if (body === undefined) {
          this.db
            .prepare("UPDATE task_operation SET status='failed' WHERE operation_id=?")
            .run(operation_id);
          continue;
        }
        out.push(
          this.tx(() => {
            const now = new Date().toISOString();
            this.db
              .prepare(
                "INSERT OR IGNORE INTO task(task_id,repo_id,display_seq,display_id,title,state,current_revision,current_digest,provenance_session_id,created_at,updated_at) VALUES(?,?,?,?,?,'open',1,?,?,?,?)",
              )
              .run(
                o.task_id,
                this.repoId,
                p.seq,
                `T-${p.seq}`,
                p.title,
                o.target_digest,
                p.provenanceSessionId ?? null,
                now,
                now,
              );
            this.db
              .prepare("INSERT OR IGNORE INTO task_revision VALUES(?,?,?,?,?,?)")
              .run(
                o.task_id,
                1,
                o.target_digest,
                Buffer.byteLength(body),
                this.rel(o.task_id as TaskId, 1),
                now,
              );
            return this.finish(
              operation_id,
              "recovered",
              null,
              1,
              null,
              "open",
              null,
              o.target_digest,
            );
          }),
        );
      } else if (o.kind === "revised") {
        const body = this.staged(o.task_id as TaskId, o.target_revision, o.target_digest);
        if (body === undefined) {
          this.db
            .prepare("UPDATE task_operation SET status='failed' WHERE operation_id=?")
            .run(operation_id);
          continue;
        }
        const r = this.owned(o.task_id as TaskId);
        if (r.current_revision === o.target_revision - 1)
          out.push(
            this.tx(() => {
              const now = new Date().toISOString();
              this.db
                .prepare("INSERT OR IGNORE INTO task_revision VALUES(?,?,?,?,?,?)")
                .run(
                  o.task_id,
                  o.target_revision,
                  o.target_digest,
                  Buffer.byteLength(body),
                  this.rel(o.task_id as TaskId, o.target_revision),
                  now,
                );
              this.db
                .prepare(
                  "UPDATE task SET current_revision=?,current_digest=?,updated_at=? WHERE task_id=? AND repo_id=?",
                )
                .run(o.target_revision, o.target_digest, now, o.task_id, this.repoId);
              return this.finish(
                operation_id,
                "recovered",
                r.current_revision,
                o.target_revision,
                r.state,
                r.state,
                r.current_digest,
                o.target_digest,
              );
            }),
          );
      }
    }
    return out;
  }
  private provenance(id?: string) {
    if (id && !this.db.prepare("SELECT 1 FROM pi_session WHERE session_id=?").get(id))
      throw new TaskAuthorityError("invalid");
  }
  private owned(id: TaskId) {
    const r = this.db
      .prepare(
        "SELECT state,current_revision,current_digest FROM task WHERE task_id=? AND repo_id=?",
      )
      .get(id, this.repoId) as
      | { state: TaskState; current_revision: number; current_digest: string }
      | undefined;
    if (!r) throw new TaskAuthorityError("conflict");
    return r;
  }
  private intent(op: string, id: TaskId, kind: string, rev: number, digest: string, _body: string) {
    this.db
      .prepare(
        "INSERT INTO task_operation(operation_id,repo_id,principal,task_id,kind,status,target_revision,target_digest,payload,created_at) VALUES(?,?,?,?,?,'intent',?,?,'{}',?)",
      )
      .run(op, this.repoId, this.cap.principal, id, kind, rev, digest, new Date().toISOString());
  }
  private finish(
    op: string,
    kind: Receipt["kind"],
    br: number | null,
    ar: number,
    bs: TaskState | null,
    as: TaskState,
    bd: string | null,
    ad: string,
  ): { task: HumanTask; receipt: Receipt } {
    const id = this.op(op).task_id as TaskId;
    this.db
      .prepare(
        "INSERT INTO task_receipt(receipt_id,task_id,kind,actor,from_revision,to_revision,from_state,to_state,digest,created_at,operation_id,before_digest,after_digest,repo_id,principal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        `receipt_${randomUUID()}`,
        id,
        kind,
        "human",
        br,
        ar,
        bs,
        as,
        ad,
        new Date().toISOString(),
        op,
        bd,
        ad,
        this.repoId,
        this.cap.principal,
      );
    this.db.prepare("UPDATE task_operation SET status='committed' WHERE operation_id=?").run(op);
    const receipt = {
      operationId: op,
      taskId: id,
      kind,
      beforeRevision: br,
      afterRevision: ar,
      beforeState: bs,
      afterState: as,
      beforeDigest: bd,
      afterDigest: ad,
    };
    return { task: this.task(id), receipt };
  }
  private task(id: TaskId): HumanTask {
    const r = this.db
      .prepare(
        "SELECT task_id,display_id,state,title,current_revision,current_digest,provenance_session_id FROM task WHERE task_id=? AND repo_id=?",
      )
      .get(id, this.repoId) as Record<string, unknown>;
    return {
      taskId: id,
      displayId: String(r.display_id),
      state: r.state as TaskState,
      title: String(r.title),
      revision: Number(r.current_revision),
      digest: String(r.current_digest),
      ...(r.provenance_session_id ? { provenanceSessionId: String(r.provenance_session_id) } : {}),
    };
  }
  private retry(op: string) {
    const existing = this.db
      .prepare("SELECT repo_id,principal,status FROM task_operation WHERE operation_id=?")
      .get(op) as { repo_id: string; principal: string; status: string } | undefined;
    if (!existing) return undefined;
    // Operation IDs are globally unique and cannot be probed or stolen across scopes.
    if (existing.repo_id !== this.repoId || existing.principal !== this.cap.principal)
      throw new TaskAuthorityError("conflict");
    if (existing.status === "intent") this.reconcile();
    const result = this.prior(op);
    if (!result) throw new TaskAuthorityError("conflict");
    return result;
  }
  private prior(op: string) {
    const r = this.db
      .prepare(
        "SELECT task_id FROM task_operation WHERE operation_id=? AND repo_id=? AND principal=? AND status='committed'",
      )
      .get(op, this.repoId, this.cap.principal) as { task_id: string } | undefined;
    if (!r) return undefined;
    const q = this.db
      .prepare(
        "SELECT kind,from_revision,to_revision,from_state,to_state,before_digest,after_digest FROM task_receipt WHERE operation_id=?",
      )
      .get(op) as any;
    return {
      task: this.task(r.task_id as TaskId),
      receipt: {
        operationId: op,
        taskId: r.task_id,
        ...q,
        kind: q.kind,
        beforeRevision: q.from_revision,
        afterRevision: q.to_revision,
        beforeState: q.from_state,
        afterState: q.to_state,
        beforeDigest: q.before_digest,
        afterDigest: q.after_digest,
      },
    };
  }
  private op(id: string) {
    return this.db
      .prepare("SELECT * FROM task_operation WHERE operation_id=? AND repo_id=? AND principal=?")
      .get(id, this.repoId, this.cap.principal) as any;
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e instanceof TaskAuthorityError ? e : new TaskAuthorityError("conflict");
    }
  }
  private staged(id: TaskId, r: number, digest: string): string | undefined {
    const p = join(privateChild(this.paths.taskBodies, this.repoId, id), `${r}.md`);
    if (!existsSync(p)) return undefined;
    const b = readFileSync(p);
    if (sha(b) !== digest) throw new TaskAuthorityError("conflict");
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  }
  private rel(id: TaskId, r: number) {
    return join("tasks", "bodies", this.repoId, id, `${r}.md`);
  }
  private publish(id: TaskId, r: number, body: string, digest: string) {
    const root = privateChild(this.paths.taskBodies, this.repoId, id);
    ensurePrivateDirectory(root);
    const target = join(root, `${r}.md`);
    if (existsSync(target)) {
      if (sha(readFileSync(target)) !== digest) throw new TaskAuthorityError("conflict");
      return;
    }
    const tmp = join(root, `.tmp-${randomUUID()}`),
      fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o400);
    renameSync(tmp, target);
    const d = openSync(dirname(target), "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
function operation(v: string) {
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(v)) throw new TaskAuthorityError("invalid");
}
function normalizeTitle(v: string) {
  const n = v.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!n || n.length > 512 || /[\u0000-\u001f\u007f]/u.test(n))
    throw new TaskAuthorityError("invalid");
  return n;
}
function validateBody(v: string) {
  if (Buffer.byteLength(v) > 1024 * 1024) throw new TaskAuthorityError("invalid");
}
function sha(v: string | Buffer) {
  return createHash("sha256").update(v).digest("hex");
}
