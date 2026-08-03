import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory, type StoragePaths, privateChild } from "../storage/paths.ts";

export const TASK_STATES = ["open", "ready", "doing", "blocked", "done", "dropped", "archived"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type TaskId = string & { readonly __taskId: unique symbol };
export interface HumanMutationContext { readonly actor: "human"; readonly provenanceSessionId?: string }
export interface TaskRevisionConflict { readonly code: "revision-conflict"; readonly currentRevision: number; readonly currentDigest: string }
export class TaskAuthorityError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "revision-conflict", message = "Task mutation could not be completed", readonly current?: {revision:number; digest:string}) { super(message); this.name = "TaskAuthorityError"; }
}
export interface AgentVisibleTask { readonly taskId: TaskId; readonly displayId: string; readonly repoId: string; readonly state: Exclude<TaskState,"open">; readonly title: string; readonly revision: number; readonly digest: string }
export interface HumanTask extends Omit<AgentVisibleTask,"state"> { readonly state: TaskState; readonly provenanceSessionId?: string }

/** Read capability deliberately has neither mutation nor body-enumeration operations. */
export class AgentTaskQuery {
  constructor(private readonly db: DatabaseSync) {}
  list(repoId: string): AgentVisibleTask[] {
    return this.db.prepare("SELECT task_id,display_id,repo_id,state,title,current_revision,current_digest FROM task WHERE repo_id=? AND state<>'open' ORDER BY display_seq").all(repoId).map(row => visible(row as Record<string,unknown>));
  }
}

/** The sole task mutation port. Construction requires an explicit human context. */
export class HumanTaskAuthority {
  private constructor(private readonly db: DatabaseSync, private readonly paths: StoragePaths, private readonly context: HumanMutationContext) {}
  static forHuman(db: DatabaseSync, paths: StoragePaths, context: HumanMutationContext): HumanTaskAuthority {
    if (context.actor !== "human") throw new TaskAuthorityError("invalid");
    return new HumanTaskAuthority(db, paths, context);
  }
  create(repoId: string, title: string, body: string): HumanTask {
    valid(repoId, title, body); const now = new Date().toISOString(); const id = `task_${randomUUID().replaceAll("-","")}` as TaskId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO task_display_sequence(repo_id,next_value) VALUES(?,2) ON CONFLICT(repo_id) DO UPDATE SET next_value=next_value+1").run(repoId);
      const seq = Number((this.db.prepare("SELECT next_value-1 AS n FROM task_display_sequence WHERE repo_id=?").get(repoId) as {n:number}).n);
      const published = publish(this.paths, repoId, id, 1, body);
      this.db.prepare("INSERT INTO task(task_id,repo_id,display_seq,display_id,title,state,current_revision,current_digest,provenance_session_id,created_at,updated_at) VALUES(?,?,?,?,?,'open',1,?,?,?,?)").run(id,repoId,seq,`T-${seq}`,title,published.digest,this.context.provenanceSessionId ?? null,now,now);
      this.db.prepare("INSERT INTO task_revision(task_id,revision,digest,bytes,relative_path,created_at) VALUES(?,?,?,?,?,?)").run(id,1,published.digest,published.bytes,published.relativePath,now);
      this.db.exec("COMMIT"); return this.get(id)!;
    } catch (e) { rollback(this.db); throw conceal(e); }
  }
  revise(id: TaskId, expectedRevision: number, body: string): HumanTask {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TaskAuthorityError("invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row=this.db.prepare("SELECT repo_id,current_revision,current_digest FROM task WHERE task_id=?").get(id) as {repo_id:string,current_revision:number,current_digest:string}|undefined;
      if (!row) throw new TaskAuthorityError("conflict");
      if (row.current_revision!==expectedRevision) throw new TaskAuthorityError("revision-conflict",undefined,{revision:row.current_revision,digest:row.current_digest});
      const revision=expectedRevision+1, now=new Date().toISOString(), p=publish(this.paths,row.repo_id,id,revision,body);
      this.db.prepare("INSERT INTO task_revision VALUES(?,?,?,?,?,?)").run(id,revision,p.digest,p.bytes,p.relativePath,now);
      const result=this.db.prepare("UPDATE task SET current_revision=?,current_digest=?,updated_at=? WHERE task_id=? AND current_revision=?").run(revision,p.digest,now,id,expectedRevision);
      if (result.changes!==1) throw new TaskAuthorityError("conflict");
      this.db.exec("COMMIT"); return this.get(id)!;
    } catch(e) { rollback(this.db); throw conceal(e); }
  }
  transition(id: TaskId, to: TaskState): HumanTask {
    if (!TASK_STATES.includes(to)) throw new TaskAuthorityError("invalid");
    try { const now=new Date().toISOString(); const r=this.db.prepare("UPDATE task SET state=?,updated_at=? WHERE task_id=?").run(to,now,id); if(r.changes!==1) throw new TaskAuthorityError("conflict"); return this.get(id)!; } catch(e){ throw conceal(e); }
  }
  get(id: TaskId): HumanTask|undefined { const r=this.db.prepare("SELECT task_id,display_id,repo_id,state,title,current_revision,current_digest,provenance_session_id FROM task WHERE task_id=?").get(id) as Record<string,unknown>|undefined; return r ? {...visible(r),state:r.state as TaskState,provenanceSessionId:r.provenance_session_id as string|undefined}:undefined; }
  readCurrentBody(id: TaskId): string { const row=this.db.prepare("SELECT r.relative_path,r.digest FROM task t JOIN task_revision r ON r.task_id=t.task_id AND r.revision=t.current_revision WHERE t.task_id=?").get(id) as {relative_path:string,digest:string}|undefined; if(!row) throw new TaskAuthorityError("conflict"); const b=readFileSync(join(this.paths.data,row.relative_path)); if(createHash("sha256").update(b).digest("hex")!==row.digest) throw new TaskAuthorityError("conflict"); return new TextDecoder("utf-8",{fatal:true}).decode(b); }
}
function visible(r:Record<string,unknown>): AgentVisibleTask { return {taskId:r.task_id as TaskId,displayId:String(r.display_id),repoId:String(r.repo_id),state:r.state as Exclude<TaskState,"open">,title:String(r.title),revision:Number(r.current_revision),digest:String(r.current_digest)}; }
function valid(repo:string,title:string,body:string){ if(!/^[A-Za-z0-9_-]{1,128}$/.test(repo)||!title.trim()||title.length>512||new TextEncoder().encode(body).length>16*1024*1024) throw new TaskAuthorityError("invalid"); }
function publish(paths:StoragePaths,repo:string,id:string,revision:number,body:string){ valid(repo,"x",body); const root=privateChild(join(paths.data,"tasks","repositories"),repo,id,"revisions"); ensurePrivateDirectory(root); const relativePath=join("tasks","repositories",repo,id,"revisions",`${revision}.md`); const target=join(paths.data,relativePath), bytes=Buffer.from(body), digest=createHash("sha256").update(bytes).digest("hex"); if(existsSync(target)){ const old=readFileSync(target); if(createHash("sha256").update(old).digest("hex")!==digest) throw new TaskAuthorityError("conflict"); return {digest,bytes:bytes.length,relativePath}; } const temp=join(root,`.tmp-${randomUUID()}`); const fd=openSync(temp,"wx",0o600); try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); } chmodSync(temp,0o400); renameSync(temp,target); const d=openSync(dirname(target),"r"); try{fsyncSync(d)}finally{closeSync(d)} return {digest,bytes:bytes.length,relativePath}; }
function rollback(db:DatabaseSync){try{db.exec("ROLLBACK")}catch{}}
function conceal(e:unknown):TaskAuthorityError { if(e instanceof TaskAuthorityError)return e; return new TaskAuthorityError("conflict"); }
