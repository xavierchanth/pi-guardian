import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardianExtension } from "./core/runtime.ts";
import { autoMode } from "./definitions/auto.ts";
import { planMode } from "./definitions/plan.ts";
import { editMode } from "./definitions/edit.ts";
import { readMode } from "./definitions/read.ts";
import { registerImplementCommand } from "./implement.ts";

const registeredModes = [autoMode, planMode, editMode, readMode];

export default function (pi: ExtensionAPI) {
	const state = registerGuardianExtension(pi, registeredModes);
	registerImplementCommand(pi, state);
}
