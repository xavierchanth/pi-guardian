import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SubagentRole } from "./domain.ts";

export interface PiTaiInstructionSet {
  system: string;
  parent: string;
  child: string;
}

export type InstructionLoader = () => PiTaiInstructionSet;

export function loadPackagedInstructions(): PiTaiInstructionSet {
  return {
    system: readInstruction("system.md"),
    parent: readInstruction("parent.md"),
    child: readInstruction("child.md"),
  };
}

export function roleInstructions(
  instructions: PiTaiInstructionSet,
  role: SubagentRole,
): string {
  if (role === "parent") return instructions.parent;
  if (role === "child") return instructions.child;
  return "";
}

function readInstruction(name: string): string {
  const path = fileURLToPath(new URL(`../../instructions/${name}`, import.meta.url));
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw error;
  }
}
