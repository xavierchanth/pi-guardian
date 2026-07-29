/**
 * Every model-facing string for the subagent surface.
 *
 * These live in one file on purpose. The tool descriptions say what a tool
 * does; the guidelines say when to reach for it; the charter says how to brief
 * a child. Judgment that used to be encoded as extra tools and enforced state
 * transitions is now written down here, where it can be read and edited.
 */

export const SPAWN_DESCRIPTION =
  "Start a subagent: an autonomous agent with its own context window that works in the background. "
  + "Returns immediately with an id; the subagent's result is delivered to you automatically when it finishes. "
  + "With isolation \"workspace\" it gets its own checkout, which you later merge or discard. "
  + "With \"shared\" it works directly in the current working copy alongside you.";

export const WAIT_DESCRIPTION =
  "Block until any listed subagent finishes, then return every listed result ready at that moment and identify those still running. "
  + "Call again with the remaining ids to collect staggered completions; already-finished agents return immediately. "
  + "Foreground user input releases the wait without stopping or steering subagents, and pending results remain collectable.";

export const CHECK_DESCRIPTION =
  "Look at a subagent's status and recent output without blocking and without consuming its result.";

export const SEND_DESCRIPTION =
  "Send a message to a subagent. A running one is redirected; a finished one is continued, "
  + "picking up the same conversation with its context intact. Use this to correct a subagent that is "
  + "drifting, or to keep talking to one you spawned as a thinking partner.";

export const CANCEL_DESCRIPTION =
  "Stop running subagents. Their workspaces are kept, so partial work can still be inspected, merged, or discarded.";

export const LIST_DESCRIPTION =
  "List every subagent this session has started, with status, backend, and workspace.";

export const MERGE_DESCRIPTION =
  "Fold a finished subagent's changes into your working copy and remove its workspace. "
  + "Strategy \"auto\" keeps history linear when that applies cleanly and otherwise merges the subagent's work in under your working commit, "
  + "where any conflict surfaces as an ordinary conflict you can resolve by editing.";

export const DISCARD_DESCRIPTION =
  "Throw away a subagent's workspace and every change in it. This cannot be undone.";

export const WORKSPACE_STATUS_DESCRIPTION =
  "List managed workspaces and what each is holding, including any left behind by an earlier session.";

/** Guidance attached to the spawn tool; this is where delegation judgment lives. */
export const DELEGATION_GUIDELINES: readonly string[] = [
  "Delegate external or source-backed research with `subagent_spawn`, `capability: \"researcher\"`, and `isolation: \"shared\"`. Delegate other work that is self-contained and worth its own context window: a focused implementation task, an independent investigation, a review of work that already exists. Do trivial or tightly coupled work yourself.",
  "Write the subagent's prompt so it stands alone. It cannot see this conversation, so state the goal, the relevant background, the acceptance criteria, and the constraints in the prompt itself.",
  "Foreground user input releases subagent_wait without cancelling subagents.",
  "A user message always addresses you, the parent. Do not relay it with subagent_send unless the user explicitly asks you to send that message to a subagent.",
  "Give a subagent its own workspace only when its work is independent of every other subagent's: different files, no shared index or manifest, and nothing that must happen in order. Use the shared working copy when you want its work to appear directly in yours.",
  "Work that builds on another subagent's changes is sequential, not parallel. Keep it in one workspace by spawning the next piece with `continue` naming the finished subagent, or make the pieces one task. Two pieces that edit a shared index, manifest, README table, or numbered list are coupled even when their other files differ.",
  "Review a subagent's work before merging it: read the changes it describes, and spawn a reviewer when the change is large or risky. Merging is not automatic and should not be reflexive.",
  "Model defaults by what the subagent is for: `opus` for design partners and reviewers, `sol` for implementation. `sol` is the default when you name nothing.",
  "Use `fable` only when I ask for it by name. It is stronger than `opus` and correspondingly more expensive; do not reach for it on your own judgment.",
  "Claude models (`fable`, `opus`, and `sonnet`) run only on the `claude` backend. Never pair them with the `pi` or `codex` harness. On `pi`, `sol`, `terra`, and `luna` select GPT-5.6 models, while `glm` and `kimi` select OpenCode Go models.",
  "Leave effort alone. Each model carries a default effort chosen for the work it is used for, and that default is almost always right. Set it only when I ask for a different reasoning level — if I say to think harder about something, raise it; if I say a task is trivial or want it fast, lower it.",
];

export const WORKSPACE_GUIDELINES: readonly string[] = [
  "A subagent's changes stay in its workspace until you merge or discard them. Nothing lands in the user's working copy on its own.",
  "If a merge reports conflicting paths, resolve them in the working copy as you would any conflict, then continue.",
  "Discarding is permanent. When work looks wrong but not worthless, merge it and revise, or leave the workspace and ask the user.",
];

export interface ChildCharterInput {
  readonly objective: string;
  /** Absolute path the child works in. */
  readonly cwd: string;
  readonly isolated: boolean;
  readonly acceptanceCriteria?: readonly string[];
  readonly constraints?: readonly string[];
  /** Picking up a workspace another subagent already worked in. */
  readonly resuming?: boolean;
}

/**
 * Builds a child's system prompt.
 *
 * The charter is what makes a subagent's output predictable enough to merge
 * without re-reading every line: it fixes what "done" means, how to leave the
 * commit, and what not to touch.
 */
export function composeChildCharter(input: ChildCharterInput): string {
  const facts = [
    "<subagent_charter>",
    "You are running as an autonomous subagent. Nobody is watching you work and you cannot ask questions;",
    "make reasonable decisions, and state any assumption or unresolved concern in your final message.",
    `Your working directory is ${input.cwd}.`,
  ];

  if (input.isolated) {
    facts.push(
      "You are working in your own checkout. Changes here do not affect anyone else until your parent merges them.",
      "Commit your work as you go with `jj describe -m \"<summary>\"` followed by `jj new`. Every change you leave behind must have a description;",
      "undescribed work cannot be merged. Do not run other history-rewriting jj commands, and do not touch git remotes.",
      "Keep your changes to the task at hand. Unrelated cleanup makes your work harder to review and merge.",
    );
  }

  if (input.resuming) {
    facts.push(
      "You are continuing work another subagent started in this workspace. Read the existing commits with `jj log`",
      "and the current diff before changing anything: some of the task may already be done, and redoing it wastes the work.",
    );
  } else {
    facts.push(
      "You are working directly in the shared working copy, alongside your parent and any other subagent in it.",
      "Keep your changes to the task you were given, and say clearly what you touched.",
    );
  }

  if (input.acceptanceCriteria?.length) {
    facts.push("You are done when all of the following hold:");
    for (const criterion of input.acceptanceCriteria) facts.push(`  - ${criterion}`);
  }
  if (input.constraints?.length) {
    facts.push("Constraints:");
    for (const constraint of input.constraints) facts.push(`  - ${constraint}`);
  }

  facts.push(
    "Your final message is your entire report to your parent — it is the only thing they see.",
    "Lead with what you did or found, then what you changed, then anything unresolved.",
    "</subagent_charter>",
  );
  return facts.join("\n");
}

/** The task text handed to the child, assembled from the spawn call. */
export function composeChildPrompt(input: {
  objective: string;
  background?: string;
  acceptanceCriteria?: readonly string[];
}): string {
  const parts = [input.objective.trim()];
  if (input.background?.trim()) parts.push(`Background:\n${input.background.trim()}`);
  if (input.acceptanceCriteria?.length) {
    parts.push(`Acceptance criteria:\n${input.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`);
  }
  return parts.join("\n\n");
}
