import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { BTW_ENTRY_TYPE, type BtwEntry } from "../../packages/pi-tai/src/sidebar/domain.ts";

test("persisted /btw entries stay outside context after reload and branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tai-btw-"));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "ordinary prompt", timestamp: Date.now() });
    const before = sm.getLeafId();
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ordinary answer" }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const persisted: BtwEntry = {
      state: "success",
      question: "SECRET_Q",
      answer: "SECRET_A",
      model: "test/model",
      timestamp: new Date(0).toISOString(),
      truncation: { input: false, output: false },
    };
    sm.appendCustomEntry(BTW_ENTRY_TYPE, persisted);
    assert.doesNotMatch(JSON.stringify(sm.buildSessionContext().messages), /SECRET_[QA]/);
    const file = sm.getSessionFile()!;
    const loaded = SessionManager.open(file);
    assert.doesNotMatch(JSON.stringify(loaded.buildSessionContext().messages), /SECRET_[QA]/);
    const loadedUser = loaded.getEntries().find((entry) => entry.type === "message");
    assert.ok(loadedUser);
    loaded.branch(loadedUser.id);
    const branched: BtwEntry = {
      state: "success",
      question: "BRANCH_Q",
      answer: "BRANCH_A",
      model: "test/model",
      timestamp: new Date(0).toISOString(),
      truncation: { input: false, output: false },
    };
    loaded.appendCustomEntry(BTW_ENTRY_TYPE, branched);
    assert.doesNotMatch(
      JSON.stringify(buildSessionContext(loaded.getEntries(), loaded.getLeafId()).messages),
      /BRANCH_[QA]/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
