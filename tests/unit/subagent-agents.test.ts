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
  assert.equal(catalog.root.name, "orchestrator");
  assert.deepEqual(catalog.root.allowedChildren, ["implementation-lead", "documenter", "reviewer", "scout", "researcher"]);
  assert.deepEqual(catalog.byName.get("implementation-lead")?.allowedChildren, ["worker", "scout", "researcher"]);
  assert.deepEqual(catalog.byName.get("worker")?.allowedChildren, ["scout", "researcher"]);
  assert.deepEqual(catalog.byName.get("scout")?.allowedChildren, []);
  assert.deepEqual(catalog.byName.get("researcher")?.allowedChildren, []);
  assert.ok(catalog.root.tools.includes("workspace_subagent"));
  assert.ok(catalog.root.tools.includes("jj_concurrency_status"));
  assert.equal(catalog.root.tools.includes("ensure_wip_change"), false);
  assert.equal(catalog.root.tools.includes("insert_change"), false);
  for (const tool of ["jj_concurrency_status", "acquire_file_set", "release_file_set", "checkpoint_change"]) {
    assert.ok(catalog.byName.get("worker")?.tools.includes(tool), tool);
  }
  assert.equal(catalog.byName.get("implementation-lead")?.tools.includes("workspace_subagent"), false);
  assert.deepEqual(catalog.byName.get("documenter")?.allowedChildren, []);
  assert.equal(catalog.root.allowedChildren.includes("worker"), false);
  for (const name of ["orchestrator", "implementation-lead", "worker", "documenter"]) assert.equal(catalog.byName.get(name)?.tools.includes("update_plan"), false, name);
  assert.ok(catalog.root.tools.includes("task_create"));
  assert.ok(catalog.root.tools.includes("request_plan_approval"));
  assert.ok(catalog.byName.get("implementation-lead")?.tools.includes("task_plan"));
  assert.ok(catalog.byName.get("reviewer")?.tools.includes("inspect_workspace_review"));
  assert.ok(catalog.byName.get("reviewer")?.tools.includes("submit_workspace_review"));
  assert.equal(catalog.byName.get("reviewer")?.tools.includes("task_status"), false);
  for (const name of ["orchestrator", "implementation-lead", "worker", "reviewer"]) {
    assert.ok(catalog.byName.get(name)?.tools.includes("request_child_status"), name);
    assert.equal(catalog.byName.get(name)?.tools.includes("request_child_summary"), false, name);
  }
  for (const name of ["orchestrator", "implementation-lead", "reviewer", "researcher"]) {
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
      { name: "documenter", model: "gpt-5.6-sol", effort: "low" },
      { name: "implementation-lead", model: "gpt-5.6-sol", effort: "medium" },
      { name: "orchestrator", model: "gpt-5.6-sol", effort: "high" },
      { name: "researcher", model: "gpt-5.6-terra", effort: "medium" },
      { name: "reviewer", model: "gpt-5.6-sol", effort: "medium" },
      { name: "scout", model: "gpt-5.6-luna", effort: "medium" },
      { name: "worker", model: "gpt-5.6-sol", effort: "low" },
    ],
  );
});

test("packaged delegating prompts require pushed-event acknowledgement before completion", () => {
  const catalog = discoverAgentDefinitions({
    cwd: "/tmp",
    projectTrusted: false,
    packagedDir: PACKAGED,
    agentDir: "/tmp/pi-tai-no-user-agents",
  });

  for (const name of ["orchestrator", "implementation-lead", "worker"]) {
    const prompt = catalog.byName.get(name)?.systemPrompt ?? "";
    assert.match(prompt, /Delegation is not completion\./, name);
    assert.match(prompt, /`await_child_event`/, name);
    assert.match(prompt, /`respond_to_child`/, name);
    assert.match(prompt, /`ack_child_event`/, name);
    assert.match(prompt, /no direct child is unresolved/, name);
    assert.match(prompt, /no terminal event remains unacknowledged/, name);
    assert.match(prompt, /never inspect private child history/, name);
  }

  assert.match(catalog.root.systemPrompt, /Every nonempty range must pass an independent Reviewer/);
  assert.match(catalog.root.systemPrompt, /work with the user as a design partner/i);
  assert.match(catalog.root.systemPrompt, /explicitly approves the current plan/);
  assert.match(catalog.root.systemPrompt, /`request_plan_approval`/);
  assert.match(catalog.root.systemPrompt, /Never launch a generic Worker directly/);
  assert.match(catalog.root.systemPrompt, /Every writable delegated task runs in its own managed workspace/);
  assert.match(catalog.byName.get("documenter")?.systemPrompt ?? "", /Modify only explicitly assigned Markdown documentation paths/);
  assert.equal(catalog.root.tools.includes("write"), false);
  assert.equal(catalog.root.tools.includes("edit"), false);
  assert.equal(catalog.root.tools.includes("bash"), false);
  for (const name of ["documenter", "reviewer", "scout", "researcher"]) assert.equal(catalog.byName.get(name)?.tools.includes("bash"), false, name);
  assert.ok(catalog.root.tools.includes("task_approve_plan"));
  assert.match(catalog.byName.get("worker")?.systemPrompt ?? "", /acquire_file_set.*checkpoint_change/s);
  for (const name of ["implementation-lead", "worker"]) {
    assert.match(
      catalog.byName.get(name)?.systemPrompt ?? "",
      /Before calling `report_to_parent`/,
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
