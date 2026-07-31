import assert from "node:assert/strict";
import test from "node:test";
import { boundContext, answerText } from "../../packages/pi-tai/src/terminal/sidebar/domain.ts";

test("sidebar context trimming keeps an assistant tool call with its result", () => {
  const old = { role: "user", content: "x".repeat(500) };
  const assistant = {
    role: "assistant",
    content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
  };
  const result = { role: "toolResult", toolCallId: "1", content: [{ type: "text", text: "ok" }] };
  const bounded = boundContext([old, assistant, result], 100);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.messages.slice(-2), [assistant, result]);
});

test("sidebar context drops orphan results and active incomplete tool calls", () => {
  const orphan = { role: "toolResult", toolCallId: "old", content: "orphan" };
  const user = { role: "user", content: "keep" };
  const active = {
    role: "assistant",
    content: [{ type: "toolCall", id: "active", name: "bash", arguments: {} }],
  };
  const bounded = boundContext([orphan, user, active], 100);
  assert.equal(bounded.truncated, true);
  assert.equal(
    bounded.messages.some((message) => message === orphan || message === active),
    false,
  );
  assert.equal(bounded.messages.at(-1), user);
});

test("sidebar context limit includes its omission marker and drops oversized coherent groups", () => {
  const bounded = boundContext([{ role: "user", content: "x".repeat(10_000) }], 30);
  assert.equal(bounded.truncated, true);
  assert.ok(Math.ceil(JSON.stringify(bounded.messages).length / 4) <= 30);
});

test("sidebar context remains a contiguous newest suffix", () => {
  const old = { role: "user", content: "old decision" };
  const oversized = { role: "assistant", content: "x".repeat(4_000) };
  const newest = { role: "user", content: "new question" };
  const bounded = boundContext([old, oversized, newest], 60);
  assert.equal(bounded.messages.includes(old), false);
  assert.equal(bounded.messages.at(-1), newest);
});

test("sidebar output bounds are explicit and empty output is rejected", () => {
  assert.deepEqual(answerText([{ type: "text", text: "abcdef" }], 5), {
    text: "abcd…",
    truncated: true,
  });
  assert.throws(() => answerText([{ type: "text", text: "  " }], 5), /empty answer/);
});
