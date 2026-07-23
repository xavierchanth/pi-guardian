import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases as loadSharedCases, type WorkspaceCase } from "../shared/cases.ts";

export type { WorkspaceSetup as Setup, WorkspaceInteraction as Interaction, WorkspaceAssertion as Assertion } from "../shared/cases.ts";
export type EvalCase = WorkspaceCase;

export async function loadCases(directory = join(fileURLToPath(new URL(".", import.meta.url)), "cases")): Promise<EvalCase[]> {
  return await loadSharedCases(directory, "workspace-skill") as EvalCase[];
}
export const backendOf=(c:EvalCase):"jj"|"git"=>c.setup.kind==="jj-repository"?"jj":"git";
