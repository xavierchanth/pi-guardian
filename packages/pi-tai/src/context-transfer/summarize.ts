import { buildSessionContext, DEFAULT_COMPACTION_SETTINGS, generateSummary, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { summaryInstructions } from "./domain.ts";
export interface SummarizeContextInput { notes?:string; ctx:ExtensionContext; pi:ExtensionAPI }
export type ContextSummarizer=(input:SummarizeContextInput)=>Promise<string|undefined>;
export const summarizeContextWithActiveModel:ContextSummarizer=async({notes,ctx,pi})=>{
 const session=buildSessionContext(ctx.sessionManager.getEntries(),ctx.sessionManager.getLeafId());
 if(session.messages.length===0)return undefined;
 const model=ctx.model;if(!model)throw new Error("No active model is selected.");
 const auth=await ctx.modelRegistry.getApiKeyAndHeaders(model);if(!auth.ok)throw new Error("error" in auth?auth.error:"Authentication failed.");
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120_000);
 try {const value=(await generateSummary(session.messages,model,DEFAULT_COMPACTION_SETTINGS.reserveTokens,auth.apiKey,auth.headers,controller.signal,summaryInstructions(notes),undefined,pi.getThinkingLevel(),undefined,auth.env)).trim();if(!value)throw new Error("The model returned an empty context summary.");return value} finally {clearTimeout(timer)}
};
