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
  assert.deepEqual(catalog.root.allowedChildren, ["planner", "worker", "scout", "researcher"]);
  assert.deepEqual(catalog.byName.get("planner")?.allowedChildren, ["worker", "scout", "researcher"]);
  assert.deepEqual(catalog.byName.get("worker")?.allowedChildren, ["scout", "researcher"]);
  assert.deepEqual(catalog.byName.get("scout")?.allowedChildren, []);
  assert.deepEqual(catalog.byName.get("researcher")?.allowedChildren, []);
  assert.ok(catalog.root.tools.includes("workspace_subagent"));
  for (const tool of ["jj_concurrency_status", "ensure_wip_change", "insert_change"]) {
    assert.ok(catalog.root.tools.includes(tool), tool);
  }
  for (const tool of ["jj_concurrency_status", "acquire_file_set", "release_file_set", "checkpoint_change"]) {
    assert.ok(catalog.byName.get("worker")?.tools.includes(tool), tool);
  }
  assert.equal(catalog.byName.get("planner")?.tools.includes("workspace_subagent"), false);
  for (const name of ["thinker", "planner", "researcher"]) {
    assert.ok(catalog.byName.get(name)?.tools.includes("web_search"), name);
    assert.ok(catalog.byName.get(name)?.tools.includes("web_fetch"), name);
  }
  for (const name of ["worker", "scout"]) {
    assert.equal(catalog.byName.get(name)?.tools.includes("web_search"), false, name);
    assert.equal(catalog.byName.get(name)?.tools.includes("web_fetch"), false, name);
  }
  assert.deepEqual(
    catalog.agents.map(({ name, model, effort }) => ({ name, model, effort })),
    [
      { name: "planner", model: "gpt-5.6-sol", effort: "high" },
      { name: "researcher", model: "gpt-5.6-terra", effort: "medium" },
      { name: "scout", model: "gpt-5.6-luna", effort: "medium" },
      { name: "thinker", model: "gpt-5.6-sol", effort: "high" },
      { name: "worker", model: "gpt-5.6-sol", effort: "low" },
    ],
  );
});

test("packaged delegating prompts require repeated wait-any collection before completion", () => {
  const catalog = discoverAgentDefinitions({
    cwd: "/tmp",
    projectTrusted: false,
    packagedDir: PACKAGED,
    agentDir: "/tmp/pi-tai-no-user-agents",
  });

  for (const name of ["thinker", "planner", "worker"]) {
    const prompt = catalog.byName.get(name)?.systemPrompt ?? "";
    assert.match(prompt, /Delegation is not completion\./, name);
    assert.match(prompt, /`wait_for_children` is wait-any/, name);
    assert.match(prompt, /call it repeatedly/, name);
    assert.match(prompt, /answer each question.*resume waiting/, name);
    assert.match(prompt, /no direct child you own is unresolved/, name);
    assert.match(prompt, /no terminal result remains uncollected/, name);
    assert.match(prompt, /`child_status` is not a substitute.*`wait_for_children`/, name);
  }

  assert.match(
    catalog.root.systemPrompt,
    /Before presenting delegated work as complete or ending your user-facing work/,
  );
  assert.match(
    catalog.root.systemPrompt,
    /substantial unrelated implementation slices.*use a separate `workspace_subagent` delegation for each slice/s,
  );
  assert.match(catalog.root.systemPrompt, /keeps each implementation history cleaner/);
  assert.match(
    catalog.root.systemPrompt,
    /Do not use workspaces for simple tasks.*explicit workspace lifecycle administration/s,
  );
  assert.match(catalog.root.systemPrompt, /ensure_wip_change.*insert_change/s);
  assert.match(catalog.byName.get("worker")?.systemPrompt ?? "", /acquire_file_set.*checkpoint_change/s);
  for (const name of ["planner", "worker"]) {
    assert.match(
      catalog.byName.get(name)?.systemPrompt ?? "",
      /Before calling `report_to_parent` or otherwise ending your run/,
      name,
    );
  }
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
