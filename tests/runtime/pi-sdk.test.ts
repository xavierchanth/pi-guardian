import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHeadlessUiContext } from "../../services/pi-runtime/src/headless-ui.ts";
import { PiSdkRuntimePort } from "../../services/pi-runtime/src/pi-runtime.ts";
import { FIELD_DESCRIPTORS } from "../../packages/pi-tai/src/config/provenance.ts";
import { DEFAULT_SESSION_POLICY } from "../../packages/pi-tai/src/config/schema.ts";
import type { RuntimeEventInput } from "../../services/pi-runtime/src/runtime-port.ts";

function pinnedPolicy() {
  return {
    sessionPolicy: {
      ...DEFAULT_SESSION_POLICY,
      modelProfiles: [...DEFAULT_SESSION_POLICY.modelProfiles],
    },
    policyProvenance: Object.fromEntries(
      Object.keys(FIELD_DESCRIPTORS).map((path) => [path, { layer: "default" as const }]),
    ),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-sdk-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await (await import("node:fs/promises")).mkdir(cwd, { recursive: true });
  return { root, cwd, agentDir, sessionDir, ...pinnedPolicy() };
}

test("hosted extension UI rejects interaction and redacts notifications", async () => {
  const records: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const ui = createHeadlessUiContext((record) => records.push(record));
  await assert.rejects(ui.select("choose", ["secret option"]), /unavailable in hosted mode: select/);
  ui.notify("private notification", "warning");
  assert.equal(records[0]?.event, "extension_notification");
  assert.deepEqual(records[0]?.data, { characters: 20 });
  assert.equal(JSON.stringify(records).includes("private notification"), false);
});

test("Pi SDK create and open prefer pinned policy without reading configuration files", async () => {
  const paths = await fixture();
  await (await import("node:fs/promises")).mkdir(paths.agentDir, { recursive: true });
  await writeFile(join(paths.agentDir, "pi-tai.json"), "{");
  const policy = {
    ...DEFAULT_SESSION_POLICY,
    compaction: { enabled: false, thresholdPercent: 42 },
    modelProfiles: [...DEFAULT_SESSION_POLICY.modelProfiles],
  };
  const provenance = Object.fromEntries(
    Object.keys(FIELD_DESCRIPTORS).map((path) => [path, { layer: "default" as const }]),
  );
  const first = new PiSdkRuntimePort();
  const session = await first.createSession({
    ...paths,
    faux: true,
    sessionPolicy: policy,
    policyProvenance: provenance,
  }, () => {});
  assert.deepEqual(first.sessionPolicy(), policy);
  await first.disposeSession();

  const second = new PiSdkRuntimePort();
  await second.openSession({
    sessionFile: session.sessionFile,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    faux: true,
    sessionPolicy: policy,
    policyProvenance: provenance,
  }, () => {});
  assert.deepEqual(second.sessionPolicy(), policy);
  await second.shutdown();
});

test("Pi SDK port loads Pi-Tai, persists faux history, and reopens it", async () => {
  const paths = await fixture();
  const events: RuntimeEventInput[] = [];
  const first = new PiSdkRuntimePort();
  const session = await first.createSession({ ...paths, faux: true }, (event) => events.push(event));
  const capabilities = await first.capabilities();
  assert.equal(capabilities.tools.includes("update_plan"), false);
  assert.ok(capabilities.commands.includes("continue"));
  assert.equal(capabilities.commands.includes("plan-status"), false);
  assert.equal(capabilities.commands.includes("jj-workspaces"), false);
  assert.equal(capabilities.commands.includes("git-worktrees"), false);
  assert.deepEqual(capabilities.extensionErrors, []);

  const turnA = await first.startPrompt(
    { turnId: "turn-a", text: "first persisted turn" },
    "prompt-a",
    (event) => events.push(event),
  );
  assert.equal(turnA.accepted, true);
  await turnA.completion;
  assert.ok(events.some((event) => event.event === "assistant.text_delta"));
  await first.disposeSession();

  const secondEvents: RuntimeEventInput[] = [];
  const second = new PiSdkRuntimePort();
  await second.openSession({
    sessionFile: session.sessionFile,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    ...pinnedPolicy(),
    faux: true,
  }, (event) => secondEvents.push(event));
  const turnB = await second.startPrompt(
    { turnId: "turn-b", text: "verify history" },
    "prompt-b",
    (event) => secondEvents.push(event),
  );
  await turnB.completion;
  const text = secondEvents
    .filter((event) => event.event === "assistant.text_delta")
    .map((event) => (event.data as { delta: string }).delta)
    .join("");
  assert.match(text, /history-present/);
  assert.match(await readFile(session.sessionFile, "utf8"), /first persisted turn/);
  await second.shutdown();
});

test("Pi SDK runtime does not expose workspace backends as capabilities", async () => {
  const paths = await fixture();
  const port = new PiSdkRuntimePort();
  await port.createSession({ ...paths, faux: true }, () => {});
  const capabilities = await port.capabilities();
  assert.equal(capabilities.sessionCapabilities.some(
    (capability) => capability.id === "jj-workspaces" || capability.id === "git-worktrees",
  ), false);
  await assert.rejects(
    port.setCapability({ capabilityId: "git-worktrees", enabled: true }, () => {}),
    /Unknown capability/,
  );
  await assert.rejects(
    port.relocateWorkspace({ backend: "git", name: "hosted-focused" }, () => {}),
    /ask the agent for a workspace/,
  );
  await port.shutdown();
});

test("Pi SDK session replacement rebinds events to only the new session", async () => {
  const firstPaths = await fixture();
  const secondPaths = await fixture();
  const seed = new PiSdkRuntimePort();
  const secondSession = await seed.createSession({ ...secondPaths, faux: true }, () => {});
  const seedPrompt = await seed.startPrompt(
    { turnId: "seed-turn", text: "seed replacement" },
    "seed-prompt",
    () => {},
  );
  await seedPrompt.completion;
  await seed.disposeSession();

  const port = new PiSdkRuntimePort();
  await port.createSession({ ...firstPaths, faux: true }, () => {});
  const replacementEvents: RuntimeEventInput[] = [];
  const replaced = await port.openSession({
    sessionFile: secondSession.sessionFile,
    agentDir: firstPaths.agentDir,
    sessionDir: firstPaths.sessionDir,
    ...pinnedPolicy(),
    faux: true,
  }, (event) => replacementEvents.push(event));
  const prompt = await port.startPrompt(
    { turnId: "replacement-turn", text: "replacement session" },
    "replacement-prompt",
    (event) => replacementEvents.push(event),
  );
  await prompt.completion;
  assert.equal(replaced.sessionId, secondSession.sessionId);
  assert.ok(replacementEvents.length > 1);
  assert.ok(replacementEvents.every((event) => !event.sessionId || event.sessionId === secondSession.sessionId));
  await port.shutdown();
});

test("Pi SDK port excludes retired update_plan and supports bounded cancellation", async () => {
  const paths = await fixture();
  const events: RuntimeEventInput[] = [];
  const port = new PiSdkRuntimePort();
  await port.createSession({ ...paths, faux: true }, (event) => events.push(event));
  assert.equal((await port.capabilities()).tools.includes("update_plan"), false);

  const slow = await port.startPrompt(
    { turnId: "turn-slow", text: "slow response" },
    "prompt-slow",
    (event) => events.push(event),
  );
  assert.equal(slow.accepted, true);
  assert.equal(await port.cancel("turn-slow"), true);
  await slow.completion;
  await port.shutdown();
});
