import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  REVIEWER_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReviewDecision,
  type ProposedAction,
  type ReviewDecision,
} from "./policy.ts";
import type { WorkContextSnapshot } from "../work-context/domain.ts";

export const REVIEWER_MODEL = "openai-codex/codex-auto-review";
export const REVIEW_TIMEOUT_MS = 30_000;

type ModelRegistry = ExtensionContext["modelRegistry"];
export type ReviewerModel = NonNullable<ReturnType<ModelRegistry["find"]>>;
type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export type ReviewResult =
  | { kind: "decision"; decision: ReviewDecision }
  | { kind: "timeout" | "cancelled" | "failure"; reason: string };

export interface ReviewRequest {
  modelRegistry: ModelRegistry;
  cwd: string;
  messages: readonly unknown[];
  workContext?: WorkContextSnapshot;
  reviewEvidence?: unknown;
  action: ProposedAction;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ReviewerDependencies {
  createSession?: typeof createAgentSession;
  createResourceLoader?: (
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
  ) => DefaultResourceLoader;
}

export function resolveReviewerModel(registry: ModelRegistry): ReviewerModel | undefined {
  const registered = registry.find("openai-codex", "codex-auto-review");
  if (registered) return registered;
  const template =
    registry.find("openai-codex", "gpt-5.4-mini") ?? registry.find("openai-codex", "gpt-5.4");
  if (!template) return undefined;
  return {
    ...template,
    id: "codex-auto-review",
    name: "Codex Auto Review",
    contextWindow: 272_000,
    maxTokens: 10_000,
  };
}

export function createModelReviewer(dependencies: ReviewerDependencies = {}) {
  return async function review(request: ReviewRequest): Promise<ReviewResult> {
    const model = resolveReviewerModel(request.modelRegistry);
    if (!model) {
      return { kind: "failure", reason: `Reviewer model is unavailable: ${REVIEWER_MODEL}.` };
    }

    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, request.timeoutMs ?? REVIEW_TIMEOUT_MS);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;
    let session: AgentSession | undefined;

    try {
      const sessionPromise = createIsolatedSession(request, model, dependencies);
      void sessionPromise.then(
        (created) => {
          if (signal.aborted && created !== session) created.dispose();
        },
        () => undefined,
      );
      session = await raceAbort(sessionPromise, signal);
      await raceAbort(
        session.prompt(
          buildReviewPrompt(
            request.messages,
            request.action,
            request.workContext,
            request.reviewEvidence,
          ),
        ),
        signal,
        session,
      );
      const output = latestAssistantText(session);
      return { kind: "decision", decision: parseReviewDecision(output) };
    } catch (error) {
      if (timedOut) return { kind: "timeout", reason: "Automatic action review timed out." };
      if (request.signal?.aborted) {
        return { kind: "cancelled", reason: "Automatic action review was cancelled." };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "failure", reason: `Automatic action review failed: ${message}` };
    } finally {
      clearTimeout(timer);
      session?.dispose();
    }
  };
}

export const reviewAction = createModelReviewer();

async function createIsolatedSession(
  request: ReviewRequest,
  model: ReviewerModel,
  dependencies: ReviewerDependencies,
): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = (
    dependencies.createResourceLoader ?? ((options) => new DefaultResourceLoader(options))
  )({
    cwd: request.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => REVIEWER_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const registryCompatibility = request.modelRegistry as unknown as {
    runtime?: unknown;
    authStorage?: unknown;
  };
  const options: Record<string, unknown> = {
    cwd: request.cwd,
    model,
    thinkingLevel: "low",
    noTools: "all",
    tools: [],
    customTools: [],
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.cwd),
    settingsManager,
  };
  if (registryCompatibility.runtime) {
    options.modelRuntime = registryCompatibility.runtime;
  } else {
    options.modelRegistry = request.modelRegistry;
    if (registryCompatibility.authStorage) options.authStorage = registryCompatibility.authStorage;
  }

  const createSession = dependencies.createSession ?? createAgentSession;
  const created = await createSession(options as Parameters<typeof createAgentSession>[0]);
  return created.session;
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  session?: AgentSession,
): Promise<T> {
  if (signal.aborted) throw new Error("review aborted");
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      if (session) void session.abort();
      finish(() => reject(new Error("review aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function latestAssistantText(session: AgentSession): string {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "reviewer provider error");
    }
    const text = message.content
      .flatMap((content) => (content.type === "text" ? [content.text] : []))
      .join("\n");
    if (!text) throw new Error("reviewer returned no decision");
    return text;
  }
  throw new Error("reviewer returned no assistant message");
}
