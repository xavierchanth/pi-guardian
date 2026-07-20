import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ApprovalGuardianFactory = (pi: ExtensionAPI) => unknown;
export type ApprovalGuardianLoader = () => Promise<{
  default: ApprovalGuardianFactory;
}>;

const loadApprovalGuardian: ApprovalGuardianLoader = () =>
  import("pi-approval-guardian/extensions/index.ts");

export async function registerApprovalGuardian(
  pi: ExtensionAPI,
  load: ApprovalGuardianLoader = loadApprovalGuardian,
): Promise<void> {
  const module = await load();
  module.default(pi);
}
