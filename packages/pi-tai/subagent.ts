import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApprovalGuardian } from "./src/guardian/register.ts";
import { registerSubagents } from "./src/subagents/register.ts";
import { registerWebTools } from "./src/web/register.ts";
import { createPiSessionWorkContextStore } from "./src/work-context/persistence.ts";
import { registerWorkContext } from "./src/work-context/register.ts";

export default function registerPiTaiSubagentRuntime(pi: ExtensionAPI): void {
  const workContext = createPiSessionWorkContextStore();
  registerWorkContext(pi, workContext);
  registerWebTools(pi);
  registerSubagents(pi, {
    runtime: "legacy-child-process",
    agentDir: getAgentDir(),
  });
  registerApprovalGuardian(pi, { workContext: () => workContext.current() });
}
