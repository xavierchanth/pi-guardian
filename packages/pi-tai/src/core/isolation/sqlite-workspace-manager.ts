import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CustodyRecord, RepositoryIdentity, WorkspaceCustodyPort } from "./custody-port.ts";
import { CustodyReconciler } from "./custody-reconciler.ts";
import type { ChangeEntry, MergeResult, MergeStrategy, SweepEntry, WorkspaceRecord } from "./domain.ts";
import { JjCli } from "./jj.ts";
import { MANAGED_WORKSPACE_PREFIX, type CreateWorkspaceInput } from "./manager.ts";
import { SQLiteCustodyCoordinator } from "./sqlite-custody-coordinator.ts";
import type { WorkspaceManagerPort } from "./workspace-manager-port.ts";

export interface SQLiteWorkspaceManagerOptions {
  jj: JjCli;
  custody: WorkspaceCustodyPort;
  coordinator: SQLiteCustodyCoordinator;
  sourcePath: string;
  workspaceRoot: string;
  rootSessionId: string;
  processIdentity?: string;
  now?: () => string;
}

/** WorkspaceManager-compatible facade whose durable authority is exclusively SQLite custody. */
export class SQLiteWorkspaceManager implements WorkspaceManagerPort {
  private readonly jj: JjCli;
  private readonly port: WorkspaceCustodyPort;
  private readonly coordinator: SQLiteCustodyCoordinator;
  private readonly sourcePath: string;
  private readonly workspaceRoot: string;
  private readonly rootSessionId: string;
  private readonly clock: () => string;
  private readonly reconciler: CustodyReconciler;
  private repository?: Promise<RepositoryIdentity>;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(o: SQLiteWorkspaceManagerOptions) {
    this.jj=o.jj; this.port=o.custody; this.coordinator=o.coordinator; this.sourcePath=o.sourcePath;
    this.workspaceRoot=o.workspaceRoot; this.rootSessionId=o.rootSessionId;
    this.clock=o.now ?? (() => new Date().toISOString());
    this.reconciler=new CustodyReconciler(this.port,{rootSessionId:o.rootSessionId,pid:process.pid,processIdentity:o.processIdentity ?? `${process.pid}:workspace`});
  }

  async get(id: string) { const r=await this.port.get(id); return r ? publicRecord(r) : undefined; }
  async list() { return (await this.port.list({rootSessionId:this.rootSessionId})).map(publicRecord); }

  create(input: CreateWorkspaceInput = {}): Promise<WorkspaceRecord> { return this.serial(async () => {
    const repo=await this.repo();
    const parent=input.parent ? await this.port.get(input.parent) : undefined;
    if (input.parent && (!parent || parent.rootSessionId!==this.rootSessionId || parent.disposition!=="attached")) throw new Error(`Unknown or inactive parent workspace ${input.parent}.`);
    const source=parent?.path ?? this.sourcePath;
    const bases=await this.jj.parentsOfWorkingCopy(source);
    const name=`${MANAGED_WORKSPACE_PREFIX}${slug(input.label)}-${randomUUID().slice(0,8)}`;
    await mkdir(this.workspaceRoot,{recursive:true,mode:0o700});
    const at=this.clock(), id=`ws-${randomUUID()}`;
    const row: CustodyRecord={id,name,path:join(this.workspaceRoot,name),repoId:repo.repoId,repoRoot:repo.lastKnownRoot,disposition:"attached",attachmentEvidence:"unknown",directoryEvidence:"unknown",baseChangeIds:bases,headChangeIds:[],conflictRetained:false,rootSessionId:this.rootSessionId,quarantined:false,attention:false,createdAt:at,updatedAt:at,...(input.ownerId?{ownerId:input.ownerId}:{}),...(input.ownerDisplayId?{ownerDisplayId:input.ownerDisplayId}:{}),...(input.parent?{parent:input.parent}:{})};
    return publicRecord(await this.coordinator.run({kind:"create",workspaceId:id,repoId:repo.repoId,repoRoot:repo.lastKnownRoot,rootSessionId:this.rootSessionId,requestedBy:"system_spawn",record:row}));
  }); }

  async pendingChanges(id: string): Promise<ChangeEntry[]|undefined> {
    const r=await this.port.get(id); if(!r || r.disposition!=="attached" || !(await exists(r.path))) return undefined;
    const head=await this.jj.changeIdAt(r.path,"@");
    return (await this.jj.range(r.path,r.baseChangeIds,head)).filter(x=>!x.empty);
  }

  assignOwner(id:string, ownerId:string, ownerDisplayId?:string):Promise<void> { return this.patch(id,{ownerId,...(ownerDisplayId?{ownerDisplayId}:{})}); }
  assignParent(id:string,parent:string):Promise<void> { return this.patch(id,{parent}); }

  merge(id:string, _strategy:MergeStrategy="auto"):Promise<MergeResult> { return this.serial(async()=>{
    let r=await this.owned(id); if(r.disposition!=="attached") return {kind:"blocked",reason:`Workspace ${r.name} is ${r.disposition}, not active.`};
    if(!(await exists(r.path))) return {kind:"blocked",reason:`Workspace directory ${r.path} is missing; run a sweep.`};
    const head=await this.jj.changeIdAt(r.path,"@"); const entries=await this.jj.range(r.path,r.baseChangeIds,head); const content=entries.filter(x=>!x.empty);
    if(!content.length){ await this.coordinator.reclaimScaffold(this.request(r)); return {kind:"no_changes",record:publicRecord(r)}; }
    const unnamed=content.filter(x=>!x.description.trim()); if(unnamed.length) return {kind:"blocked",reason:`${unnamed.length} change(s) in ${r.name} have no description; describe them before merging.`};
    const heads=await this.jj.headsOf(r.path,content.map(x=>x.changeId)); r=await this.refresh(r,{headChangeIds:heads});
    const parent=r.parent ? await this.owned(r.parent) : undefined; const targetPath=parent?.path ?? this.sourcePath; const target=await this.jj.changeIdAt(targetPath,"@");
    const parents=await this.jj.parentsOfWorkingCopy(targetPath); const strategy=parents.length===1 && await this.jj.isEmpty(targetPath,"@") ? "linear" : "merge-under";
    const done=await this.coordinator.run({...this.request(r),kind:r.conflictRetained?"finalize_merge":"merge",requestedBy:"model_tool",targetChangeId:target,targetPath});
    const conflicts=await this.jj.conflictedPaths(targetPath); const summary={strategy,changeIds:content.map(x=>x.changeId),conflictPaths:conflicts} as const;
    if(done.disposition==="attached") return {kind:"retained_conflicts",record:publicRecord(done),summary};
    return {kind:"merged",record:publicRecord({...done,merge:summary}),summary};
  }); }

  discard(id:string):Promise<{discardedChangeIds:readonly string[]}> { return this.serial(async()=>{
    let r=await this.owned(id); const ids=[...r.headChangeIds];
    if(await exists(r.path)){ const head=await this.jj.changeIdAt(r.path,"@"); const entries=await this.jj.range(r.path,r.baseChangeIds,head); const heads=await this.jj.headsOf(r.path,entries.map(x=>x.changeId)); r=await this.refresh(r,{headChangeIds:heads}); ids.splice(0,ids.length,...entries.map(x=>x.changeId)); }
    await this.coordinator.run({...this.request(r),kind:"abandon",requestedBy:"user"}); return {discardedChangeIds:ids};
  }); }

  sweep(activeOwners:readonly string[]=[]):Promise<SweepEntry[]> { return this.serial(async()=>{
    const live=new Set(activeOwners), out:SweepEntry[]=[];
    for(const r of await this.port.list({repoId:(await this.repo()).repoId})) {
      if(r.rootSessionId!==this.rootSessionId){out.push({id:r.id,name:r.name,disposition:"kept",reason:"Owned by a different root session."});continue;}
      if(r.ownerId&&live.has(r.ownerId)){out.push({id:r.id,name:r.name,disposition:"kept",reason:"Owner is still running."});continue;}
      const dir=await exists(r.path), attached=await this.jj.workspaceHead(r.repoRoot,r.name);
      const rr=await this.reconciler.reconcile(r,{repository:"same",attachment:attached?"present":"absent",directory:dir?"present":"absent",heads:attached?{kind:"unique",changeId:attached}:{kind:"hidden",changeIds:r.headChangeIds}});
      if(rr.disposition==="attached"&&dir){const changes=await this.pendingChanges(rr.id); if(changes?.length){out.push({id:r.id,name:r.name,disposition:"needs_attention",reason:`Holds ${changes.length} unmerged change(s) from a previous session.`});continue;} await this.coordinator.reclaimScaffold(this.request(rr)); out.push({id:r.id,name:r.name,disposition:"reclaimed",reason:"Workspace was empty."});}
      else out.push({id:r.id,name:r.name,disposition:rr.disposition==="incident"?"needs_attention":"kept",reason:rr.incident?.reason ?? "Custody evidence retained."});
    } return out;
  }); }

  async resolveCustody(id:string):Promise<WorkspaceRecord|undefined>{ const r=await this.port.get(id); if(!r)return undefined; const head=await this.jj.workspaceHead(r.repoRoot,r.name); return publicRecord(await this.reconciler.reconcile(r,{repository:"same",attachment:head?"present":"absent",directory:(await exists(r.path))?"present":"absent",heads:head?{kind:"unique",changeId:head}:{kind:"hidden",changeIds:r.headChangeIds}})); }
  private request(r:CustodyRecord){return {workspaceId:r.id,repoId:r.repoId,repoRoot:r.repoRoot,rootSessionId:this.rootSessionId} as const;}
  private async owned(id:string){const r=await this.port.get(id);if(!r)throw new Error(`Unknown workspace ${id}.`);if(r.rootSessionId!==this.rootSessionId)throw new Error(`Refusing to mutate workspace ${r.name}: custody belongs to another root.`);return r;}
  private patch(id:string,p:Partial<CustodyRecord>):Promise<void>{return this.serial(async()=>{const r=await this.owned(id);await this.refresh(r,p);});}
  private async refresh(r:CustodyRecord,p:Partial<CustodyRecord>){const now=this.clock(),opId=`manager:${randomUUID()}`;await this.port.begin({opId,workspaceId:r.id,repoId:r.repoId,kind:"metadata",requestedBy:"manager",pid:process.pid,processIdentity:`${process.pid}:workspace`,now});return this.port.commit(opId,{workspaceId:r.id,ownRootSessionId:this.rootSessionId,cause:"heads_refreshed",patch:p,now});}
  private repo(){return this.repository ??= (async()=>{const root=await this.jj.repositoryRoot(this.sourcePath), evidence=await this.jj.repositoryRoots(root);return this.port.establishRepository({roots:evidence.roots,rootsTruncated:evidence.truncated,canonicalRoot:root,now:this.clock()});})();}
  private serial<T>(f:()=>Promise<T>):Promise<T>{const n=this.mutations.then(f,f);this.mutations=n.catch(()=>{});return n;}
}
function publicRecord(r:CustodyRecord):WorkspaceRecord{return {version:2,id:r.id,name:r.name,path:r.path,repoRoot:r.repoRoot,phase:r.disposition==="attached"?"active":r.disposition==="merged"?"merged":r.disposition==="incident"?"incident":"discarded",baseChangeIds:r.baseChangeIds,rootChangeId:r.rootChangeId ?? r.headChangeIds[0] ?? "",rootSessionId:r.rootSessionId,createdAt:r.createdAt,updatedAt:r.updatedAt,...(r.ownerId?{ownerId:r.ownerId}:{}),...(r.ownerDisplayId?{ownerDisplayId:r.ownerDisplayId}:{}),...(r.parent?{parent:r.parent}:{}),...(r.merge?{merge:r.merge}:{}),...(r.incident?{incident:r.incident}:{})};}
function slug(s?:string){return (s??"agent").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,24)||"agent";}
async function exists(p:string){try{await stat(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}}
