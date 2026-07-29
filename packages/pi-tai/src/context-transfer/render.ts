import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export const CONTEXT_IMPORT_TYPE="pi-tai:context-import";
export function registerContextImportRenderer(pi:ExtensionAPI):void {pi.registerMessageRenderer(CONTEXT_IMPORT_TYPE,(message,_options,theme)=>{const text=typeof message.details==="object"&&message.details&&"summary" in message.details?String((message.details as {summary:string}).summary):message.content;const excerpt=text.replace(/\s+/g," ").slice(0,120);return new Text(theme.fg("accent","Context import")+theme.fg("muted",` — ${excerpt}${text.length>120?"…":""}`),0,0)})}
