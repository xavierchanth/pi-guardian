import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiTaiConfigService } from "../config/register.ts";
import type { TitleGenerator } from "./generate.ts";
import {
  heuristicSessionTitle,
  isMeaningfulPrompt,
  normalizeSessionTitle,
} from "./normalize.ts";

export function registerSessionTitle(
  pi: ExtensionAPI,
  configService: PiTaiConfigService,
  generateTitle: TitleGenerator,
): void {
  let candidatePrompt: string | undefined;
  let attempted = false;
  let generation = 0;
  let controller: AbortController | undefined;

  pi.on("session_start", () => {
    candidatePrompt = undefined;
    attempted = Boolean(pi.getSessionName());
    controller?.abort();
    controller = new AbortController();
    generation++;
  });

  pi.on("before_agent_start", (event) => {
    if (attempted || candidatePrompt || pi.getSessionName()) return;
    if (isMeaningfulPrompt(event.prompt)) candidatePrompt = event.prompt.trim();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (attempted || !candidatePrompt || pi.getSessionName()) return;
    attempted = true;
    const prompt = candidatePrompt;
    candidatePrompt = undefined;
    const config = configService.current().sessionTitle;
    const activeGeneration = generation;
    let raw = "";

    if (config.provider && config.model) {
      try {
        raw = await generateTitle({
          prompt,
          config,
          ctx,
          signal: controller?.signal,
        });
      } catch {
        raw = "";
      }
    }

    if (controller?.signal.aborted || activeGeneration !== generation || pi.getSessionName()) return;
    const title =
      normalizeSessionTitle(raw, config.maxWords) ||
      heuristicSessionTitle(prompt, config.maxWords);
    pi.setSessionName(title);
  });

  pi.on("session_shutdown", () => {
    generation++;
    controller?.abort();
    controller = undefined;
  });
}
