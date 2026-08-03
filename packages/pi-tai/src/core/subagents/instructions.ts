import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PiTaiInstructionSet {
  system: string;
}

export type InstructionLoader = () => PiTaiInstructionSet;

export function loadPackagedInstructions(): PiTaiInstructionSet {
  return { system: readInstruction("system.md") };
}

function readInstruction(name: string): string {
  const path = fileURLToPath(new URL(`../../../instructions/${name}`, import.meta.url));
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
