import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerGuardianExtension } from "./core/runtime";
import { autoMode } from "./definitions/auto";
import { planMode } from "./definitions/plan";
import { editMode } from "./definitions/edit";
import { readMode } from "./definitions/read";

const registeredModes = [autoMode, planMode, editMode, readMode];

export default function (pi: ExtensionAPI) {
	registerGuardianExtension(pi, registeredModes);
}
