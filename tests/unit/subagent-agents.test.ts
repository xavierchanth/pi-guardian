import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import {
  discoverAgentDefinitions,
  validateAgentTools,
} from "../../packages/pi-tai/src/subagents/agents.ts";

const PACKAGED = join(import.meta.dirname, "../../packages/pi-tai/agents");

test("packaged agent definitions provide the intended acyclic hierarchy", () => {
  const catalog = discoverAgentDefinitions({
    cwd: "/tmp",
    projectTrusted: false,
    packagedDir: PACKAGED,
    agentDir: "/tmp/pi-tai-no-user-agents",
  });
  assert.equal(catalog.root.name, "thinker");
  assert.deepEqual(catalog.root.allowedChildren, ["worker", "scout", "researcher"]);
  assert.deepEqual(catalog.byName.get("worker")?.allowedChildren, ["scout", "researcher"]);
  assert.deepEqual(catalog.byName.get("scout")?.allowedChildren, []);
  assert.deepEqual(catalog.byName.get("researcher")?.allowedChildren, []);
  assert.deepEqual(
    catalog.agents.map(({ name, model, effort }) => ({ name, model, effort })),
    [
      { name: "researcher", model: "gpt-5.6-terra", effort: "medium" },
      { name: "scout", model: "gpt-5.6-luna", effort: "medium" },
      { name: "thinker", model: "gpt-5.6-sol", effort: "high" },
      { name: "worker", model: "gpt-5.6-sol", effort: "low" },
    ],
  );
});

test("trusted project definitions override user and packaged definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-agent-catalog-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project", "nested");
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await mkdir(join(root, "project", ".pi", "agents"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(agentDir, "agents", "scout.md"), definition({
    name: "scout",
    description: "user scout",
    model: "openai-codex/user-scout",
  }));
  const projectDefinition = join(root, "project-scout.md");
  await writeFile(projectDefinition, definition({
    name: "scout",
    description: "project scout",
    model: "openai-codex/project-scout",
  }));
  await symlink(projectDefinition, join(root, "project", ".pi", "agents", "scout.md"));

  const untrusted = discoverAgentDefinitions({
    cwd: project,
    projectTrusted: false,
    packagedDir: PACKAGED,
    agentDir,
  });
  assert.equal(untrusted.byName.get("scout")?.description, "user scout");

  const trusted = discoverAgentDefinitions({
    cwd: project,
    projectTrusted: true,
    packagedDir: PACKAGED,
    agentDir,
  });
  assert.equal(trusted.byName.get("scout")?.description, "project scout");
  assert.equal(trusted.byName.get("scout")?.source, "project");
  assert.match(trusted.projectAgentsDir ?? "", /\.pi\/agents$/);
});

test("agent definitions reject cycles, missing children, and tool-policy mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-invalid-agents-"));
  await writeFile(join(root, "root.md"), definition({
    name: "root",
    description: "root",
    root: true,
    tools: ["subagent"],
    children: ["child"],
  }));
  await writeFile(join(root, "child.md"), definition({
    name: "child",
    description: "child",
    tools: ["subagent"],
    children: ["root"],
  }));
  assert.throws(
    () => discoverAgentDefinitions({
      cwd: "/tmp",
      projectTrusted: false,
      packagedDir: root,
      agentDir: "/tmp/pi-tai-no-user-agents",
    }),
    /cycle|Root agent/,
  );

  await writeFile(join(root, "child.md"), definition({
    name: "child",
    description: "child",
    tools: ["read"],
    children: ["missing"],
  }));
  assert.throws(
    () => discoverAgentDefinitions({
      cwd: "/tmp",
      projectTrusted: false,
      packagedDir: root,
      agentDir: "/tmp/pi-tai-no-user-agents",
    }),
    /both the subagent tool/,
  );
});

test("tool validation fails before launch when a role names unavailable tools", () => {
  const catalog = discoverAgentDefinitions({
    cwd: "/tmp",
    projectTrusted: false,
    packagedDir: PACKAGED,
    agentDir: "/tmp/pi-tai-no-user-agents",
  });
  assert.throws(
    () => validateAgentTools(catalog.root, new Set(["read"])),
    /requires unavailable tools/,
  );
  validateAgentTools(catalog.byName.get("scout")!, new Set(["read", "grep", "find", "ls", "bash"]));
});

function definition(options: {
  name: string;
  description: string;
  model?: string;
  root?: boolean;
  tools?: string[];
  children?: string[];
}): string {
  return `---\nname: ${options.name}\ndescription: ${options.description}\n${options.root ? "root: true\n" : ""}model: ${options.model ?? "openai-codex/test"}\neffort: low\ntools:\n${(options.tools ?? ["read"]).map((tool) => `  - ${tool}`).join("\n")}\n${(options.children ?? []).length > 0 ? `allowed-children:\n${options.children!.map((child) => `  - ${child}`).join("\n")}` : "allowed-children: []"}\nuncertainty-handling: block\n---\n\nPrompt for ${options.name}.\n`;
}
