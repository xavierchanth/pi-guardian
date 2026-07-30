import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { BTW_ENTRY_TYPE } from "../../packages/pi-tai/src/sidebar/domain.ts";

test("persisted /btw entries stay outside context after reload and branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tai-btw-"));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "ordinary prompt", timestamp: Date.now() });
    const before = sm.getLeafId();
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ordinary answer" }], api: "test", provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    sm.appendCustomEntry(BTW_ENTRY_TYPE, { state: "success", question: "SECRET_Q", answer: "SECRET_A" });
    assert.doesNotMatch(JSON.stringify(sm.buildSessionContext().messages), /SECRET_[QA]/);
    const file = sm.getSessionFile()!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const loaded = SessionManager.open(file);
    assert.doesNotMatch(JSON.stringify(loaded.buildSessionContext().messages), /SECRET_[QA]/);
    const loadedUser = loaded.getEntries().find((entry) => entry.type === "message");
    assert.ok(loadedUser);
    loaded.branch(loadedUser.id);
    loaded.appendCustomEntry(BTW_ENTRY_TYPE, { question: "BRANCH_Q", answer: "BRANCH_A" });
    assert.doesNotMatch(JSON.stringify(buildSessionContext(loaded.getEntries(), loaded.getLeafId()).messages), /BRANCH_[QA]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
