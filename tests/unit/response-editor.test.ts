import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  extractResponse,
  findLastAssistantText,
  formatResponseDocument,
} from "../../packages/pi-tai/src/response-editor/document.ts";
import {
  buildEditorArguments,
  isNeovimInvocation,
  NEOVIM_RESPONSE_POSITION_COMMAND,
  parseEditorCommand,
} from "../../packages/pi-tai/src/response-editor/command.ts";

test("response document shows a fenced preview and a blank response block", () => {
  assert.equal(
    formatResponseDocument("Last answer"),
    [
      "<!-- pi-tai: only the response block is submitted; without an opening response tag, the whole document is submitted -->",
      "## Last agent message (preview only)",
      "",
      "<agent-message>",
      "Last answer",
      "</agent-message>",
      "",
      "## Your response",
      "",
      "<response>",
      "",
      "</response>",
    ].join("\n"),
  );
});

test("response document preserves a draft and neutralizes response tags in previews", () => {
  const document = formatResponseDocument(
    "Use <response>text</response> in the example.",
    "Existing draft",
  );

  assert.match(document, /Use &lt;response&gt;text&lt;\/response&gt; in the example\./);
  assert.match(document, /<response>\nExisting draft\n<\/response>$/);
  assert.deepEqual(extractResponse(document), {
    kind: "response",
    text: "Existing draft",
  });
});

test("response extraction ignores preview text and accepts a missing closing tag", () => {
  assert.deepEqual(
    extractResponse("preview that must not leak\n<response>\nFirst line\nSecond line"),
    { kind: "response", text: "First line\nSecond line" },
  );
});

test("response extraction uses the shipped final closing tag", () => {
  assert.deepEqual(
    extractResponse("<response>\nLiteral </response> in my reply\n</response>"),
    { kind: "response", text: "Literal </response> in my reply" },
  );
});

test("response extraction returns the whole document without an opening tag", () => {
  assert.deepEqual(extractResponse("preview only\nuser text"), {
    kind: "response",
    text: "preview only\nuser text",
  });
});

test("last assistant text skips tool-only turns and non-text blocks", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: [
      { type: "text", text: "First block" },
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "Second block" },
    ] } },
    { type: "message", message: { role: "toolResult", content: [] } },
    { type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    ] } },
  ] as unknown as SessionEntry[];

  assert.equal(findLastAssistantText(entries), "First block\nSecond block");
  assert.equal(findLastAssistantText([]), undefined);
});

test("editor command parser supports arguments, quoting, and executable paths", () => {
  assert.deepEqual(parseEditorCommand("nvim --clean"), {
    executable: "nvim",
    args: ["--clean"],
  });
  assert.deepEqual(parseEditorCommand("'/Applications/Neo Vim/nvim' -f"), {
    executable: "/Applications/Neo Vim/nvim",
    args: ["-f"],
  });
  assert.deepEqual(parseEditorCommand('code --wait "--profile=Work Space"'), {
    executable: "code",
    args: ["--wait", "--profile=Work Space"],
  });
  assert.equal(parseEditorCommand("nvim 'unfinished"), undefined);
});

test("NeoVim detection handles paths, Windows names, and env wrappers", () => {
  assert.equal(isNeovimInvocation({ executable: "/opt/homebrew/bin/nvim", args: [] }), true);
  assert.equal(isNeovimInvocation({ executable: "C:\\tools\\nvim.exe", args: [] }), true);
  assert.equal(
    isNeovimInvocation({ executable: "/usr/bin/env", args: ["NVIM_APPNAME=clean", "nvim", "--clean"] }),
    true,
  );
  assert.equal(isNeovimInvocation({ executable: "vim", args: [] }), false);
  assert.equal(isNeovimInvocation({ executable: "code", args: ["--wait"] }), false);
});

test("only contextual NeoVim launches receive the response cursor command", () => {
  const nvim = { executable: "nvim", args: ["--clean"] };
  assert.deepEqual(buildEditorArguments(nvim, "/tmp/response.md", true), [
    "--clean",
    NEOVIM_RESPONSE_POSITION_COMMAND,
    "/tmp/response.md",
  ]);
  assert.deepEqual(buildEditorArguments(nvim, "/tmp/plain.md", false), [
    "--clean",
    "/tmp/plain.md",
  ]);
  assert.deepEqual(
    buildEditorArguments({ executable: "code", args: ["--wait"] }, "/tmp/response.md", true),
    ["--wait", "/tmp/response.md"],
  );
});
