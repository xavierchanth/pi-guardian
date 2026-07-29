import { mkdir, readFile, writeFile, unlink, link, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { artifactPath, parseContextTransferArtifact, type ContextTransferArtifact } from "./domain.ts";
export class ArtifactLoadError extends Error { readonly kind:"missing"|"corrupt"|"unsupported"|"id-mismatch"; constructor(kind:"missing"|"corrupt"|"unsupported"|"id-mismatch", message:string){super(message);this.kind=kind} }
export interface ContextTransferStore { root:string; save(a:ContextTransferArtifact):Promise<void>; load(id:string):Promise<ContextTransferArtifact>; exists(id:string):Promise<boolean>; prune(now?:Date):Promise<void> }
export function contextExportRoot(agentDir:string){return join(agentDir,"pi-tai","context-exports")}
export function createFileContextTransferStore(agentDir:string):ContextTransferStore {
 const root=contextExportRoot(agentDir);
 return { root,
  async exists(id){try{await stat(artifactPath(root,id));return true}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e}},
  async save(a){const valid=parseContextTransferArtifact(a);await mkdir(root,{recursive:true,mode:0o700});const dest=artifactPath(root,valid.id);const tmp=join(root,`.${valid.id}.${process.pid}.${crypto.randomUUID()}.tmp`);try{await writeFile(tmp,JSON.stringify(valid)+"\n",{mode:0o600,flag:"wx"});await link(tmp,dest)}finally{await unlink(tmp).catch(()=>{})}},
  async load(id){const path=artifactPath(root,id);let raw:string;try{raw=await readFile(path,"utf8")}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")throw new ArtifactLoadError("missing",`No context export with ID ${id}.`);throw e}try{return parseContextTransferArtifact(JSON.parse(raw),id)}catch(e){const kind=(e as {kind?:ArtifactLoadError["kind"]}).kind??"corrupt";throw new ArtifactLoadError(kind,(e as Error).message)}},
  async prune(now=new Date()){let names:string[];try{names=await readdir(root)}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e}const files=(await Promise.all(names.filter(n=>/^[0-9A-HJKMNP-TV-Z]{8}\.json$/.test(n)).map(async n=>({n,s:await stat(join(root,n))})))).sort((a,b)=>b.s.mtimeMs-a.s.mtimeMs);const cutoff=now.getTime()-30*86400_000;await Promise.all(files.filter((f,i)=>i>=50||f.s.mtimeMs<cutoff).map(f=>unlink(join(root,f.n))))}
 };
}
