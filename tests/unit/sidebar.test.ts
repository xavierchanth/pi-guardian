import assert from "node:assert/strict";
import test from "node:test";
import { boundContext, answerText } from "../../packages/pi-tai/src/sidebar/domain.ts";

test("sidebar context trimming keeps an assistant tool call with its result", () => {
  const old = { role: "user", content: "x".repeat(500) };
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] };
  const result = { role: "toolResult", toolCallId: "1", content: [{ type: "text", text: "ok" }] };
  const bounded = boundContext([old, assistant, result], 100);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.messages.slice(-2), [assistant, result]);
});

test("sidebar output bounds are explicit", () => {
  assert.deepEqual(answerText([{ type: "text", text: "abcdef" }], 5), { text: "abcd…", truncated: true });
});
