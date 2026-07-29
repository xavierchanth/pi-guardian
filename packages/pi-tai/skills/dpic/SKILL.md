---
name: dpic
description: Use when work is large enough to have parts and should be designed, planned, implemented through subagents, and closed out — multi-file features, refactors, migrations, or any request where implementation should be delegated to subagents while design and review stay in the main conversation. The cycle repeats and several can run at once, so it also applies when continuing or branching work already underway.
---

# DPIC

DPIC is a way of running substantial work in four movements: design, plan, implement, close. The user and the main conversation do the thinking; subagents do the typing.

The model the user is talking to is the model they chose, so design and planning happen in the main conversation, where the user can push back. Implementation goes to subagents: each one gets its own checkout, works on its own, and reports back. The conversation never loses its context to a mechanical edit loop, and the user never loses the ability to argue about the design.

DPIC is a cycle, not a pipeline. Closing one round often reveals the next — a verification that raises a question, a piece deliberately deferred, a design decision that only becomes obvious once the code exists. That is the workflow behaving normally, not a failure of the first pass. Start another cycle rather than stretching the current one to cover work it was not designed against.

Several cycles can be in flight at once. Independent tracks run concurrently, each with its own design, plan, and subagents, and they do not need to be in the same phase as each other — one can be closing while another is still being designed. Keep them separate when their designs do not depend on each other, and say which cycle a given piece of work belongs to so the user can follow more than one at a time. Merge them into a single cycle only when they genuinely share a design decision.

Going backwards is allowed. If implementation invalidates something the plan assumed, return to design rather than pushing through on a plan that is now wrong. If the user changes direction, the current cycle is what changes.

Scale the ceremony to the work. If something can be inspected, changed, and verified within the current turn, just do it and say so — a one-line fix does not need a design phase or a subagent. The phases below are for work that genuinely has parts.

## Design

Ground the request before proposing anything: read the code, the tests, the configuration, and the docs that actually govern the area. Delegate the wide sweeps. `subagent_spawn` with `isolation: "shared"` puts a subagent in the user's working copy to investigate the codebase. For external research, set `capability: "researcher"` without flooding the main conversation. Spawn several at once — they run concurrently and their findings come back on their own.

### Working with a design partner

A design partner is optional. Design in the main conversation when the shape of the work is already clear, or when the user is thinking out loud and wants a reply now rather than a considered one. Bring in a partner when the decision is consequential enough to be worth a stronger model's judgment, when a second reading would catch something a single perspective would not, or when the user asks for one.

Start it like any other subagent: `model: "opus"` is the default for design work, and `isolation: "shared"` lets it read the working copy as it actually stands, including uncommitted work. Its opening objective should carry the problem, what has already been established, what has been ruled out and why, and the specific judgment being asked for — it sees none of this conversation, and a partner briefed as though it does will answer a question nobody asked.

The conversation continues after it finishes. A design partner settles at the end of every reply, exactly like any other subagent. Sending it another message with `subagent_send` resumes that same conversation with its full context intact — it remembers what it already said, so a follow-up should read as the next thing said between two people, not as a fresh briefing. Do not re-explain what was covered, and do not spawn a second partner to continue a discussion the first one was having; spawning again starts from nothing and throws away everything already established.

Each exchange is a turn: send a message, the partner runs, its reply comes back. `subagent_wait` blocks until a listed partner finishes, and foreground user input releases the wait without cancelling the partner.

Relay verbatim in both directions. Pass the user's words through as written, and report the partner's reply as it wrote it, saying plainly which party is speaking. Do not summarise, condense, or "clean up" either side. The user asked for that model because they want its reasoning, and a digest of it is not the thing they asked for. When the user's message is a reaction to something the partner said, send it as their reaction — including disagreement, which is usually the most useful thing in the exchange.

Close the partner out when the design settles. Its conclusions belong in the plan, written down, not left in a subagent's transcript.

Report what was found, separating observation from inference. Then surface the decisions that would change the shape of the result: behaviour, scope, interfaces, data, compatibility, failure handling, and what "done" means. Ask about those, and only those. Do not ask questions the repository already answers, and do not ask permission to proceed.

Design is finished when implementation will not have to invent intent. File layout, naming, and sequencing are not design.

## Plan

Write the plan down where it will survive the conversation — a document in the repository, or a task list.

Then decompose it for delegation. A good piece is one a subagent can finish alone: its own files, its own acceptance criteria, no mid-flight coordination with another subagent. Pieces that would have to negotiate with each other are one piece, or they are sequential. Sequential pieces run one after another in a single workspace: spawn the first, then spawn the next with `continue` naming the finished subagent. Separate workspaces branch from the same base and cannot see each other's changes. A shared index, manifest, README table, or numbered list makes otherwise separate pieces coupled. Getting this boundary right is most of what makes parallel implementation work.

Say what is about to be delegated and why, then start. Do not wait for approval unless the plan changed something agreed during design.

## Implement

Use `subagent_spawn` with `isolation: "workspace"` — one subagent per independent piece, all in the same turn so they run in parallel. Dependent pieces share one workspace and run in order via `continue`; do not fan them out.

Write each objective to stand alone. The subagent sees nothing of the main conversation: give it the goal, the background it cannot discover for itself, the acceptance criteria it can check, and the constraints it must respect. A vague objective produces work that has to be thrown away.

Implementation runs on `sol` by default, which suits most pieces. Use `fable` only when the user asks for it by name. Claude models (`fable`, `opus`, and `sonnet`) always use the `claude` backend—never the `pi` or `codex` harness. On the `pi` harness, `sol`, `terra`, and `luna` select the GPT-5.6 family, while `glm` and `kimi` select GLM 5.2 and Kimi K3 through OpenCode Go. Leave effort alone as well: each model carries a default chosen for the work it does, and it should be raised or lowered only when the user asks for a different reasoning level.

Results arrive on their own. `subagent_wait` blocks for listed runs and returns completed results, while `subagent_check` looks in on one without blocking. Use `subagent_send` to correct one that is drifting, and `subagent_cancel` plus a fresh spawn with `continue` when one is stuck and a different model should take over its workspace.

The main conversation still owns the user's working copy. Investigation, coordination, and anything small enough to do directly stay there.

## Close

Finish the work, do not just collect it.

Read what each subagent actually did — its report and the changes it left behind. Delegation is not completion, and a confident summary is not evidence. For anything substantial, have it reviewed by a subagent that did not write it; spawn the reviewer with `model: "opus"`.

Merge what is right with `workspace_merge` and discard what is not with `workspace_discard`. If a merge reports conflicting paths, resolve them in the working copy as any other conflict would be resolved.

Then verify the whole, which is the part no individual subagent could do: run the tests, check the acceptance criteria, and confirm the pieces fit together. Update the documentation and status records the change affects.

Report what changed, what was reviewed, what was verified, and what is still open. Say plainly when something did not work — a failed test named is worth more than a summary that glosses it.

If the user changes direction along the way, revisit the plan rather than pushing the original one through.
