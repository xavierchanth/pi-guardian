import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkContext } from "./register.ts";

export { registerWorkContext } from "./register.ts";
export * from "./domain.ts";
export * from "./persistence.ts";
export * from "./presentation.ts";

export default function registerWorkContextPlugin(pi: ExtensionAPI) {
  return registerWorkContext(pi);
}
